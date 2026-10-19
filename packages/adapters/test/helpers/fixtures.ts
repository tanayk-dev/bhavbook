// Test-only helpers: load fixtures the way the server will hand them to adapters.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import type { AdapterInput, Cell, FileProbe, SheetData } from '../../src/index.js';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

/** The single fixture file in `fixtures/<broker>/<kind>/`. */
export function fixturePath(broker: string, kind: string): string {
  const dir = path.join(FIXTURES, broker, kind);
  const [file] = readdirSync(dir);
  if (!file) throw new Error(`no fixture in ${dir}`);
  return path.join(dir, file);
}

export function textInput(broker: string, kind: string): AdapterInput & { type: 'text' } {
  return { type: 'text', text: readFileSync(fixturePath(broker, kind), 'latin1') };
}

function toCell(value: unknown): Cell {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;
}

/** Mirrors packages/server/src/workers/spreadsheet-core.mjs (cached values, header:1, blank rows kept). */
export function sheetsOf(file: string): SheetData[] {
  const book = XLSX.read(readFileSync(file), { cellFormula: false, cellDates: false, cellNF: false });
  return book.SheetNames.map((name) => {
    const sheet = book.Sheets[name];
    if (!sheet) return { name, rows: [] };
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });
    return { name, rows: rows.map((row) => row.map(toCell)) };
  });
}

export function sheetInput(broker: string, kind: string): AdapterInput & { type: 'sheets' } {
  return { type: 'sheets', sheets: sheetsOf(fixturePath(broker, kind)) };
}

/** What detect() gets: the first 64 KB of text, or sheet names with their first 20 rows. */
export function probeOf(input: AdapterInput): FileProbe {
  if (input.type === 'text') return { type: 'text', head: input.text.slice(0, 64 * 1024) };
  return {
    type: 'sheets',
    sheets: input.sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.slice(0, 20) })),
  };
}
