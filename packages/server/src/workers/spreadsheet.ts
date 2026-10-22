// Reads an XLSX or legacy XLS file into plain sheet data in an isolated worker thread (ADR-0023, plan S5a).
// Limits: file size, unpacked size and part count (checked on the zip's central directory before anything is
// inflated), sheets, rows, columns, cells, wall-clock time and worker heap. Only real spreadsheet containers are
// accepted (SheetJS would otherwise parse arbitrary text as CSV). Errors are SpreadsheetErrors with fixed messages.
import { Worker } from 'node:worker_threads';
import { inflateRawSync } from 'node:zlib';
import { sheetDataSchema, type SheetData } from '@bhavbook/adapters';
import { z } from 'zod';

export class SpreadsheetError extends Error {
  override readonly name = 'SpreadsheetError';
}

export interface SpreadsheetLimits {
  readonly maxBytes?: number;
  readonly maxUnpackedBytes?: number;
  readonly maxZipEntries?: number;
  readonly maxCompressionRatio?: number;
  readonly maxSheets?: number;
  readonly maxRows?: number;
  readonly maxColumns?: number;
  readonly maxCells?: number;
  readonly timeoutMs?: number;
  readonly maxHeapMb?: number;
}

export const DEFAULT_LIMITS: Required<SpreadsheetLimits> = {
  maxBytes: 25 * 1024 * 1024,
  maxUnpackedBytes: 200 * 1024 * 1024,
  maxZipEntries: 500,
  maxCompressionRatio: 200,
  maxSheets: 64,
  maxRows: 200_000,
  maxColumns: 1_000,
  maxCells: 5_000_000,
  timeoutMs: 10_000,
  maxHeapMb: 512,
};

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_HEADER = 30;
const STORED = 0;
const DEFLATED = 8;
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;
// Beside this module from source; the installed CLI bundles the worker as `dist/spreadsheet-worker.mjs` (S16).
const WORKER_URL = new URL('./spreadsheet-worker.mjs', import.meta.url);

const MESSAGES: Readonly<Record<string, string>> = {
  too_many_sheets: 'spreadsheet has too many sheets',
  too_many_rows: 'spreadsheet has too many rows',
  too_many_columns: 'spreadsheet has too many columns',
  too_many_cells: 'spreadsheet has too many cells',
  bad_sheet_name: 'spreadsheet has an invalid sheet name',
  unreadable: 'spreadsheet could not be read',
};

const replySchema = z.union([
  z.object({ ok: z.literal(true), sheets: z.array(sheetDataSchema).max(DEFAULT_LIMITS.maxSheets) }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);

/** True for an XLSX (zip) or legacy XLS (OLE2 compound file) container. */
export function isSpreadsheetContainer(bytes: Buffer): boolean {
  return bytes.subarray(0, 4).equals(ZIP_MAGIC) || bytes.subarray(0, 8).equals(OLE2_MAGIC);
}

/**
 * Inflates one part, never past the size it declares, and requires exactly that size: a part that lies about its
 * size is refused before the parser (which trusts the data, not the declaration) can inflate it unbounded.
 */
function checkPart(bytes: Buffer, central: number, compressed: number, unpacked: number): void {
  const mismatch = new SpreadsheetError('spreadsheet part does not match its declared size');
  const method = bytes.readUInt16LE(central + 10);
  const local = bytes.readUInt32LE(central + 42);
  if (local + LOCAL_HEADER > bytes.length || bytes.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    throw new SpreadsheetError('spreadsheet is not a valid zip file');
  }
  const start = local + LOCAL_HEADER + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
  if (start + compressed > bytes.length) throw new SpreadsheetError('spreadsheet is not a valid zip file');
  if (method === STORED) {
    if (compressed !== unpacked) throw mismatch;
    return;
  }
  if (method !== DEFLATED) throw new SpreadsheetError('spreadsheet uses an unsupported compression');
  let inflated: Buffer;
  try {
    // One byte of headroom: more than declared overflows the cap and throws.
    inflated = inflateRawSync(bytes.subarray(start, start + compressed), { maxOutputLength: unpacked + 1 });
  } catch {
    throw mismatch;
  }
  if (inflated.length !== unpacked) throw mismatch;
}

/**
 * Reads the zip central directory and rejects zip bombs: too many parts, too much declared unpacked data, or an
 * implausible compression ratio. Declared sizes can lie, so each part is then inflated up to its declared size and
 * must match it exactly. The worker's limits and timeout remain the second line of defence.
 */
export function inspectZip(
  bytes: Buffer,
  limits: Pick<
    Required<SpreadsheetLimits>,
    'maxUnpackedBytes' | 'maxZipEntries' | 'maxCompressionRatio'
  > = DEFAULT_LIMITS,
): { entries: number; unpackedBytes: number } {
  const searchFrom = Math.max(0, bytes.length - EOCD_SEARCH);
  let end = -1;
  for (let offset = bytes.length - EOCD_MIN; offset >= searchFrom; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new SpreadsheetError('spreadsheet is not a valid zip file');
  const entries = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (entries > limits.maxZipEntries) throw new SpreadsheetError('spreadsheet has too many parts');
  if (directoryOffset + directorySize > end)
    throw new SpreadsheetError('spreadsheet is not a valid zip file');

  let cursor = directoryOffset;
  let unpackedBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new SpreadsheetError('spreadsheet is not a valid zip file');
    }
    const compressed = bytes.readUInt32LE(cursor + 20);
    const unpacked = bytes.readUInt32LE(cursor + 24);
    unpackedBytes += unpacked;
    const tooDense =
      unpacked > 1024 * 1024 && unpacked > Math.max(compressed, 1) * limits.maxCompressionRatio;
    if (unpackedBytes > limits.maxUnpackedBytes || tooDense) {
      throw new SpreadsheetError('spreadsheet is too large when unpacked');
    }
    checkPart(bytes, cursor, compressed, unpacked);
    cursor +=
      46 +
      bytes.readUInt16LE(cursor + 28) +
      bytes.readUInt16LE(cursor + 30) +
      bytes.readUInt16LE(cursor + 32);
  }
  return { entries, unpackedBytes };
}

/** Only the error's code (e.g. ERR_WORKER_OUT_OF_MEMORY) is kept: messages may echo file content. */
function codeOf(error: unknown): string {
  return error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'unknown';
}

export function readSpreadsheet(bytes: Buffer, limits: SpreadsheetLimits = {}): Promise<SheetData[]> {
  const settings = { ...DEFAULT_LIMITS, ...limits };
  try {
    if (bytes.length > settings.maxBytes) throw new SpreadsheetError('spreadsheet is too large');
    if (!isSpreadsheetContainer(bytes)) throw new SpreadsheetError('file is not an XLSX or XLS spreadsheet');
    if (bytes.subarray(0, 4).equals(ZIP_MAGIC)) inspectZip(bytes, settings);
  } catch (error) {
    return Promise.reject(
      error instanceof SpreadsheetError ? error : new SpreadsheetError('spreadsheet could not be read'),
    );
  }

  // Copy into a fresh buffer we can transfer, so the caller's Buffer is never shared with the worker.
  const copy = new Uint8Array(bytes);
  const workerLimits = {
    maxRows: settings.maxRows,
    maxColumns: settings.maxColumns,
    maxCells: settings.maxCells,
    maxSheets: settings.maxSheets,
  };
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_URL, {
        workerData: { bytes: copy, limits: workerLimits },
        transferList: [copy.buffer],
        resourceLimits: { maxOldGenerationSizeMb: settings.maxHeapMb, maxYoungGenerationSizeMb: 64 },
      });
    } catch (error) {
      reject(new SpreadsheetError('spreadsheet reader could not start', { cause: codeOf(error) }));
      return;
    }
    let settled = false;
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      outcome();
    };
    const timer = setTimeout(() => {
      finish(() => {
        reject(new SpreadsheetError('spreadsheet parsing timed out'));
      });
    }, settings.timeoutMs);

    worker.once('message', (message: unknown) => {
      const reply = replySchema.safeParse(message);
      finish(() => {
        if (!reply.success) reject(new SpreadsheetError('spreadsheet could not be read'));
        else if (reply.data.ok) resolve(reply.data.sheets);
        else reject(new SpreadsheetError(MESSAGES[reply.data.code] ?? 'spreadsheet could not be read'));
      });
    });
    worker.once('error', (error) => {
      finish(() => {
        reject(new SpreadsheetError('spreadsheet could not be read', { cause: codeOf(error) }));
      });
    });
    worker.once('exit', () => {
      finish(() => {
        reject(new SpreadsheetError('spreadsheet could not be read'));
      });
    });
  });
}
