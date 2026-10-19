// Reads an XLSX or legacy XLS file into plain sheet data in an isolated worker thread (ADR-0023, plan S5a).
// Limits: file size, total rows, columns per sheet, wall-clock time and worker heap. Only real spreadsheet containers
// are accepted (SheetJS would otherwise parse arbitrary text as CSV). Errors are SpreadsheetErrors with fixed messages.
import { Worker } from 'node:worker_threads';
import { sheetDataSchema, type SheetData } from '@bhavbook/adapters';
import { z } from 'zod';

export class SpreadsheetError extends Error {
  override readonly name = 'SpreadsheetError';
}

export interface SpreadsheetLimits {
  readonly maxBytes?: number;
  readonly maxRows?: number;
  readonly maxColumns?: number;
  readonly timeoutMs?: number;
  readonly maxHeapMb?: number;
}

export const DEFAULT_LIMITS: Required<SpreadsheetLimits> = {
  maxBytes: 25 * 1024 * 1024,
  maxRows: 200_000,
  maxColumns: 1_000,
  timeoutMs: 10_000,
  maxHeapMb: 512,
};

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const WORKER_URL = new URL('./spreadsheet-worker.mjs', import.meta.url);

const MESSAGES: Readonly<Record<string, string>> = {
  too_many_rows: 'spreadsheet has too many rows',
  too_many_columns: 'spreadsheet has too many columns',
  unreadable: 'spreadsheet could not be read',
};

const replySchema = z.union([
  z.object({ ok: z.literal(true), sheets: z.array(sheetDataSchema) }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);

/** True for an XLSX (zip) or legacy XLS (OLE2 compound file) container. */
export function isSpreadsheetContainer(bytes: Buffer): boolean {
  return bytes.subarray(0, 4).equals(ZIP_MAGIC) || bytes.subarray(0, 8).equals(OLE2_MAGIC);
}

export function readSpreadsheet(bytes: Buffer, limits: SpreadsheetLimits = {}): Promise<SheetData[]> {
  const settings = { ...DEFAULT_LIMITS, ...limits };
  if (bytes.length > settings.maxBytes)
    return Promise.reject(new SpreadsheetError('spreadsheet is too large'));
  if (!isSpreadsheetContainer(bytes))
    return Promise.reject(new SpreadsheetError('file is not an XLSX or XLS spreadsheet'));

  // Copy into a fresh buffer we can transfer, so the caller's Buffer is never shared with the worker.
  const copy = new Uint8Array(bytes);
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      workerData: { bytes: copy, maxRows: settings.maxRows, maxColumns: settings.maxColumns },
      transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: settings.maxHeapMb, maxYoungGenerationSizeMb: 64 },
      stdout: true,
      stderr: true,
    });
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
        reject(new SpreadsheetError('spreadsheet could not be read', { cause: error }));
      });
    });
    worker.once('exit', () => {
      finish(() => {
        reject(new SpreadsheetError('spreadsheet could not be read'));
      });
    });
  });
}
