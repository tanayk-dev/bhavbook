// Reads an XLSX or legacy XLS file into plain sheet data in an isolated worker thread (ADR-0023, plan S5a).
// Limits: file size, unpacked size and part count (checked on the zip's central directory, then each part's real
// size before the parser sees it), sheets, rows, columns, cells, wall-clock time and worker heap. Only real spreadsheet containers are
// accepted (SheetJS would otherwise parse arbitrary text as CSV). Errors are SpreadsheetErrors with fixed messages.
import { Worker } from 'node:worker_threads';
import { promisify } from 'node:util';
import { inflateRaw } from 'node:zlib';
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
const CENTRAL_HEADER = 46;
const ENCRYPTED = 0x1;
/** Sizes follow the data (a data descriptor); the local header may then hold zeros. */
const DESCRIPTOR = 0x8;
const ZIP64_EXTRA = 0x0001;
const STORED = 0;
const DEFLATED = 8;
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;
// Beside this module from source; the installed CLI bundles the worker as `dist/spreadsheet-worker.mjs` (S16).
const WORKER_URL = new URL('./spreadsheet-worker.mjs', import.meta.url);
const inflate = promisify(inflateRaw);

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

/** One part as the central directory describes it, cross-checked against its local header. */
interface ZipPart {
  readonly start: number;
  readonly compressed: number;
  readonly unpacked: number;
  readonly method: number;
}

const invalidZip = (): SpreadsheetError => new SpreadsheetError('spreadsheet is not a valid zip file');
const sizeMismatch = (): SpreadsheetError =>
  new SpreadsheetError('spreadsheet part does not match its declared size');
const headersDisagree = (): SpreadsheetError =>
  new SpreadsheetError('spreadsheet part headers disagree with its directory');

/**
 * The part a central directory entry describes. A parser may read the local header instead of the directory, so
 * both must agree on the compression method and the name, and neither may be encrypted. Its data must lie before
 * the directory.
 */
/** True when an extra-field block (id, size, data records) holds a ZIP64 size record. */
function hasZip64(bytes: Buffer, from: number, length: number): boolean {
  for (let at = from; at + 4 <= from + length; at += 4 + bytes.readUInt16LE(at + 2)) {
    if (bytes.readUInt16LE(at) === ZIP64_EXTRA) return true;
  }
  return false;
}

function partAt(bytes: Buffer, central: number, dataEnd: number): ZipPart {
  const flags = bytes.readUInt16LE(central + 8);
  const method = bytes.readUInt16LE(central + 10);
  const compressed = bytes.readUInt32LE(central + 20);
  const unpacked = bytes.readUInt32LE(central + 24);
  const name = bytes.subarray(
    central + CENTRAL_HEADER,
    central + CENTRAL_HEADER + bytes.readUInt16LE(central + 28),
  );
  const local = bytes.readUInt32LE(central + 42);
  if (local + LOCAL_HEADER > dataEnd || bytes.readUInt32LE(local) !== LOCAL_SIGNATURE) throw invalidZip();
  const localNameLength = bytes.readUInt16LE(local + 26);
  const localName = bytes.subarray(local + LOCAL_HEADER, local + LOCAL_HEADER + localNameLength);
  if ((flags | bytes.readUInt16LE(local + 6)) & ENCRYPTED)
    throw new SpreadsheetError('spreadsheet is encrypted');
  if (bytes.readUInt16LE(local + 8) !== method || !localName.equals(name)) throw headersDisagree();
  // The parser sizes its buffers from the local header: its sizes must be the directory's (or zeros, when a data
  // descriptor carries them), and no ZIP64 record may override them.
  const localSizes = [bytes.readUInt32LE(local + 18), bytes.readUInt32LE(local + 22)];
  const sameSizes = localSizes[0] === compressed && localSizes[1] === unpacked;
  const deferred = (flags & DESCRIPTOR) !== 0 && localSizes[0] === 0 && localSizes[1] === 0;
  if (!sameSizes && !deferred) throw headersDisagree();
  const localExtra = bytes.readUInt16LE(local + 28);
  const centralExtraAt = central + CENTRAL_HEADER + name.length;
  if (
    hasZip64(bytes, local + LOCAL_HEADER + localNameLength, localExtra) ||
    hasZip64(bytes, centralExtraAt, bytes.readUInt16LE(central + 30))
  ) {
    throw new SpreadsheetError('spreadsheet uses ZIP64 sizes, which a spreadsheet never needs');
  }
  const start = local + LOCAL_HEADER + localNameLength + localExtra;
  if (start + compressed > dataEnd) throw invalidZip();
  if (method === STORED && compressed !== unpacked) throw sizeMismatch();
  if (method !== STORED && method !== DEFLATED) {
    throw new SpreadsheetError('spreadsheet uses an unsupported compression');
  }
  return { start, compressed, unpacked, method };
}

/**
 * Reads the central directory, entry by entry, to exactly its declared end: too many parts, too much declared
 * unpacked data or an implausible compression ratio is a zip bomb.
 */
function readDirectory(
  bytes: Buffer,
  limits: Pick<Required<SpreadsheetLimits>, 'maxUnpackedBytes' | 'maxZipEntries' | 'maxCompressionRatio'>,
): ZipPart[] {
  const searchFrom = Math.max(0, bytes.length - EOCD_SEARCH);
  let end = -1;
  for (let offset = bytes.length - EOCD_MIN; offset >= searchFrom; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw invalidZip();
  const entries = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (entries > limits.maxZipEntries) throw new SpreadsheetError('spreadsheet has too many parts');
  // The directory runs right up to the end record: nothing unlisted hides between them.
  if (directoryOffset + directorySize !== end) throw invalidZip();

  const parts: ZipPart[] = [];
  let cursor = directoryOffset;
  let unpackedBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + CENTRAL_HEADER > end || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw invalidZip();
    const next =
      cursor +
      CENTRAL_HEADER +
      bytes.readUInt16LE(cursor + 28) +
      bytes.readUInt16LE(cursor + 30) +
      bytes.readUInt16LE(cursor + 32);
    if (next > end) throw invalidZip();
    const compressed = bytes.readUInt32LE(cursor + 20);
    const unpacked = bytes.readUInt32LE(cursor + 24);
    unpackedBytes += unpacked;
    const tooDense =
      unpacked > 1024 * 1024 && unpacked > Math.max(compressed, 1) * limits.maxCompressionRatio;
    if (unpackedBytes > limits.maxUnpackedBytes || tooDense) {
      throw new SpreadsheetError('spreadsheet is too large when unpacked');
    }
    parts.push(partAt(bytes, cursor, directoryOffset));
    cursor = next;
  }
  // As many entries as the end record says, and no more: a parser walking the directory reads nothing unchecked.
  if (cursor !== end) throw invalidZip();
  return parts;
}

/**
 * Rejects zip bombs before the parser sees the file. The directory's limits come first (see `readDirectory`); then,
 * because declared sizes can lie and the parser trusts the data, each deflated part is inflated up to its declared
 * size and must match it exactly. Inflating runs on the libuv thread pool, so the server keeps answering. The
 * worker's limits and timeout remain the second line of defence.
 */
export async function inspectZip(
  bytes: Buffer,
  limits: Pick<
    Required<SpreadsheetLimits>,
    'maxUnpackedBytes' | 'maxZipEntries' | 'maxCompressionRatio'
  > = DEFAULT_LIMITS,
): Promise<{ entries: number; unpackedBytes: number }> {
  const parts = readDirectory(bytes, limits);
  for (const part of parts) {
    if (part.method !== DEFLATED) continue;
    let inflated: Buffer;
    try {
      // One byte of headroom: more than declared overflows the cap and fails.
      inflated = await inflate(bytes.subarray(part.start, part.start + part.compressed), {
        maxOutputLength: part.unpacked + 1,
      });
    } catch {
      throw sizeMismatch();
    }
    if (inflated.length !== part.unpacked) throw sizeMismatch();
  }
  return { entries: parts.length, unpackedBytes: parts.reduce((total, part) => total + part.unpacked, 0) };
}

/** Only the error's code (e.g. ERR_WORKER_OUT_OF_MEMORY) is kept: messages may echo file content. */
function codeOf(error: unknown): string {
  return error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'unknown';
}

export async function readSpreadsheet(bytes: Buffer, limits: SpreadsheetLimits = {}): Promise<SheetData[]> {
  const settings = { ...DEFAULT_LIMITS, ...limits };
  try {
    if (bytes.length > settings.maxBytes) throw new SpreadsheetError('spreadsheet is too large');
    if (!isSpreadsheetContainer(bytes)) throw new SpreadsheetError('file is not an XLSX or XLS spreadsheet');
    if (bytes.subarray(0, 4).equals(ZIP_MAGIC)) await inspectZip(bytes, settings);
  } catch (error) {
    throw error instanceof SpreadsheetError ? error : new SpreadsheetError('spreadsheet could not be read');
  }
  return parseInWorker(bytes, settings);
}

function parseInWorker(bytes: Buffer, settings: Required<SpreadsheetLimits>): Promise<SheetData[]> {
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
