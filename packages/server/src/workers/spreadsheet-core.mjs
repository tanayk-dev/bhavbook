// Parsing core for readSpreadsheet (ADR-0023). Plain ESM so the worker thread can load it without a TypeScript
// loader, and tests can import it in-process. Formulas are never evaluated or returned: only cached values. Results
// carry codes, never file content.
import * as XLSX from 'xlsx';

/** @typedef {{ maxRows: number, maxColumns: number, maxCells: number, maxSheets: number }} ParseLimits */
/** @typedef {string | number | boolean | null} Cell */
/** @typedef {{ ok: true, sheets: { name: string, rows: Cell[][] }[] } | { ok: false, code: string }} ParseReply */

const HOSTILE_SHEET_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** @param {unknown} value @returns {Cell} */
function toCell(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;
}

/**
 * @param {Uint8Array} bytes
 * @param {ParseLimits} limits
 * @returns {ParseReply}
 */
export function parseWorkbook(bytes, limits) {
  /** @type {XLSX.WorkBook} */
  let book;
  try {
    book = XLSX.read(bytes, {
      type: 'buffer',
      cellFormula: false,
      cellHTML: false,
      cellNF: false,
      cellStyles: false,
      cellDates: false,
      sheetRows: limits.maxRows + 1,
    });
  } catch {
    return { ok: false, code: 'unreadable' };
  }
  if (book.SheetNames.length > limits.maxSheets) return { ok: false, code: 'too_many_sheets' };
  let totalRows = 0;
  let totalCells = 0;
  /** @type {{ name: string, rows: Cell[][] }[]} */
  const sheets = [];
  for (const name of book.SheetNames) {
    if (HOSTILE_SHEET_NAMES.has(name)) return { ok: false, code: 'bad_sheet_name' };
    const sheet = Object.hasOwn(book.Sheets, name) ? book.Sheets[name] : undefined;
    // With sheetRows set, !ref is truncated; !fullref is the sheet's true extent.
    const ref = sheet?.['!fullref'] ?? sheet?.['!ref'];
    if (!sheet || !ref) {
      sheets.push({ name, rows: [] });
      continue;
    }
    const range = XLSX.utils.decode_range(ref);
    const rows = range.e.r - range.s.r + 1;
    const columns = range.e.c - range.s.c + 1;
    if (columns > limits.maxColumns) return { ok: false, code: 'too_many_columns' };
    totalRows += rows;
    totalCells += rows * columns;
    if (totalRows > limits.maxRows) return { ok: false, code: 'too_many_rows' };
    if (totalCells > limits.maxCells) return { ok: false, code: 'too_many_cells' };
    /** @type {unknown[][]} */
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true });
    sheets.push({ name, rows: data.map((row) => row.map(toCell)) });
  }
  return { ok: true, sheets };
}
