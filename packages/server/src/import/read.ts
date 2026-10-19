// Turning uploaded bytes into adapter input. Spreadsheets go through the isolated worker (S5a); everything else is
// decoded as text (UTF-8, falling back to Latin-1 for legacy exports). Nothing here keeps the file name.
import { createHash } from 'node:crypto';
import type { AdapterInput, FileProbe } from '@bhavbook/adapters';
import { DEFAULT_LIMITS, isSpreadsheetContainer, readSpreadsheet } from '../workers/spreadsheet.js';

/** Same cap as the spreadsheet worker, for every kind of file. */
export const MAX_IMPORT_BYTES = DEFAULT_LIMITS.maxBytes;

/** What detect() sees: the first 64 KB of text, or sheet names with their first 20 rows (adapter contract). */
const PROBE_TEXT_CHARS = 64 * 1024;
const PROBE_SHEET_ROWS = 20;

/**
 * Text files are parsed on the main thread (only spreadsheets need the isolated worker), so their shape is bounded
 * first: the same row limit as spreadsheets, and no line longer than a CSV row could reasonably be.
 */
export const MAX_TEXT_LINES = DEFAULT_LIMITS.maxRows;
export const MAX_LINE_CHARS = 64 * 1024;

function withinTextBounds(text: string): boolean {
  let lines = 0;
  for (let start = 0; start < text.length; lines += 1) {
    if (lines >= MAX_TEXT_LINES) return false;
    const end = text.indexOf('\n', start);
    const stop = end === -1 ? text.length : end;
    if (stop - start > MAX_LINE_CHARS) return false;
    start = stop + 1;
  }
  return true;
}

export type ReadOutcome =
  | { readonly ok: true; readonly input: AdapterInput; readonly probe: FileProbe; readonly sha256: string }
  | { readonly ok: false; readonly reason: 'too_large' | 'malformed' };

function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function readImportFile(bytes: Buffer): Promise<ReadOutcome> {
  if (bytes.length > MAX_IMPORT_BYTES) return { ok: false, reason: 'too_large' };
  const sha256 = sha256Hex(bytes);
  if (isSpreadsheetContainer(bytes)) {
    try {
      const sheets = await readSpreadsheet(bytes);
      const probe = {
        type: 'sheets' as const,
        sheets: sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.slice(0, PROBE_SHEET_ROWS) })),
      };
      return { ok: true, input: { type: 'sheets', sheets }, probe, sha256 };
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  }
  const text = decodeText(bytes);
  if (!withinTextBounds(text)) return { ok: false, reason: 'too_large' };
  return {
    ok: true,
    input: { type: 'text', text },
    probe: { type: 'text', head: text.slice(0, PROBE_TEXT_CHARS) },
    sha256,
  };
}
