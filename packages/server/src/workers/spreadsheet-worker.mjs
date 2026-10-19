// Worker thread body for readSpreadsheet (ADR-0023): parses one XLSX/XLS file with SheetJS and posts plain sheet data.
// Runs isolated with its own memory limit, so a hostile file can only crash this thread. Formulas are never
// evaluated or returned: only cached cell values cross back to the main thread. Messages carry codes, never content.
import { parentPort, workerData } from 'node:worker_threads';
import * as XLSX from 'xlsx';

/** @typedef {{ bytes: Uint8Array, maxRows: number, maxColumns: number }} Job */

/** @param {unknown} value */
function toCell(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;
}

/** @param {Job} job */
function run(job) {
  const book = XLSX.read(job.bytes, {
    type: 'buffer',
    cellFormula: false,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    cellDates: false,
    sheetRows: job.maxRows + 1,
  });
  let totalRows = 0;
  const sheets = [];
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    const ref = sheet?.['!fullref'] ?? sheet?.['!ref'];
    if (!sheet || !ref) {
      sheets.push({ name, rows: [] });
      continue;
    }
    const range = XLSX.utils.decode_range(ref);
    if (range.e.c - range.s.c + 1 > job.maxColumns) return { ok: false, code: 'too_many_columns' };
    totalRows += range.e.r - range.s.r + 1;
    if (totalRows > job.maxRows) return { ok: false, code: 'too_many_rows' };
    /** @type {unknown[][]} */
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true });
    sheets.push({ name, rows: rows.map((row) => row.map(toCell)) });
  }
  return { ok: true, sheets };
}

try {
  parentPort?.postMessage(run(/** @type {Job} */ (workerData)));
} catch {
  parentPort?.postMessage({ ok: false, code: 'unreadable' });
}
