// Dhan Tax Report .xls, Equity sheet (NOTES.md): Dhan's own FIFO lots per section with gross P&L and total charges.
// Statements only; it is the source for lots the trade history lacks (IPO allotments, off-market credits). The
// header block (name, UCC, mobile, email) is never read.
import type { Cell, InstrumentHint, ParseResult, RowError, SheetData, StatementRow } from '../contract.js';
import { cellText, columnIndex, isBlankRow, moneyMicro } from '../cells.js';
import { fromDayMonthYear } from './dates.js';

const TAX_REPORT_SHEETS = ['Equity', 'F&O', 'Global Transactions', 'DP Charges Statement'];
const SECTION_PREFIX = 'Equity Segment - ';
/** Section title (after the prefix) -> lot section; null for sections without realised lots. */
const SECTIONS: ReadonlyMap<string, string | null> = new Map([
  ['Intraday / Speculation', 'intraday'],
  ['Short Term', 'short_term'],
  ['Long Term', 'long_term'],
  ['Open Sell', 'open_sell'],
  ['Free Holdings', null],
]);
const REQUIRED = [
  'Security Name',
  'ISIN',
  'Buy Date',
  'Buy Qty.',
  'Buy Value',
  'Sell Date',
  'Sell Qty.',
  'Sell Value',
];
const MONEY: readonly (readonly [string, string])[] = [
  ['Avg. Buy Price', 'avg_buy_price_micro'],
  ['Buy Value', 'buy_value_micro'],
  ['Avg. Sell Price', 'avg_sell_price_micro'],
  ['Sell Value', 'sell_value_micro'],
  ['Gross P&L', 'gross_pnl_micro'],
  ['Total Charges', 'total_charges_micro'],
  ['Net P&L', 'net_pnl_micro'],
];
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const RANGE = /from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/;

export function isTaxReport(sheetNames: readonly string[]): boolean {
  return TAX_REPORT_SHEETS.every((name) => sheetNames.includes(name));
}

function texts(row: readonly Cell[]): string[] {
  return row.map(cellText).filter((text): text is string => text !== null);
}

/** `Free Holdings from ...` carries dates, so titles match by prefix. */
function sectionOf(title: string): { known: boolean; section: string | null } {
  const rest = title.slice(SECTION_PREFIX.length);
  for (const [name, section] of SECTIONS)
    if (rest === name || rest.startsWith(`${name} `)) return { known: true, section };
  return { known: false, section: null };
}

function lotOf(
  row: readonly Cell[],
  columns: Map<string, number>,
  section: string,
  line: number,
): StatementRow | null {
  const at = (name: string): Cell | undefined => row[columns.get(name) ?? -1];
  const name = cellText(at('Security Name'));
  const isin = cellText(at('ISIN')) ?? '';
  const buyDate = fromDayMonthYear(cellText(at('Buy Date')) ?? '');
  const sellDate = fromDayMonthYear(cellText(at('Sell Date')) ?? '');
  const quantity = cellText(at('Buy Qty.')) ?? '';
  const sellQuantity = cellText(at('Sell Qty.')) ?? '';
  if (!name || !buyDate || !sellDate || !/^\d+$/.test(quantity) || !/^\d+$/.test(sellQuantity)) return null;
  const data: Record<string, bigint | string | null> = {
    sell_qty: sellQuantity,
    holding_days: cellText(at('Holding Period')),
  };
  for (const [column, field] of MONEY) data[field] = moneyMicro(at(column), 2);
  if (data.buy_value_micro === null || data.sell_value_micro === null) return null;
  const key = { section, name, isin, buy_date: buyDate, sell_date: sellDate, quantity };
  const identity = [
    'tax',
    section,
    isin || name,
    buyDate,
    sellDate,
    quantity,
    String(data.buy_value_micro),
  ].join('|');
  return { kind: 'dhan.tax.lot', dedupKey: identity, key, data, line };
}

interface State {
  section: string | null;
  columns: Map<string, number> | null;
}

/**
 * Walks the Equity sheet: an `Equity Segment - ...` title starts a section, a row starting with `Sr.` is its
 * header, any other multi-cell row is a lot. A single-text row that is not a title (the footer notes) ends the
 * section; an unknown section title is reported.
 */
function collectLots(sheet: SheetData): { lots: StatementRow[]; errors: RowError[] } {
  const lots: StatementRow[] = [];
  const errors: RowError[] = [];
  const seen = new Map<string, number>();
  const state: State = { section: null, columns: null };
  for (const [index, row] of sheet.rows.entries()) {
    const line = index + 1;
    if (isBlankRow(row)) continue;
    const cells = texts(row);
    if (cells.length === 1) {
      const title = cells[0] ?? '';
      const { known, section } = title.startsWith(SECTION_PREFIX)
        ? sectionOf(title)
        : { known: true, section: null };
      if (!known) errors.push({ line, code: 'unknown_section' });
      state.section = section;
      state.columns = null;
      continue;
    }
    if (state.section === null) continue;
    if (cells[0] === 'Sr.') {
      state.columns = columnIndex(row);
      if (REQUIRED.some((name) => !state.columns?.has(name))) {
        errors.push({ line, code: 'bad_header' });
        state.columns = null;
      }
      continue;
    }
    const lot = state.columns === null ? null : lotOf(row, state.columns, state.section, line);
    if (lot === null) {
      errors.push({ line, code: 'bad_lot' });
      continue;
    }
    const count = (seen.get(lot.dedupKey) ?? 0) + 1;
    seen.set(lot.dedupKey, count);
    lots.push({ ...lot, dedupKey: `${lot.dedupKey}#${String(count)}` });
  }
  return { lots, errors };
}

export function parseTaxReport(sheets: readonly SheetData[]): ParseResult {
  const equity = sheets.find((sheet) => sheet.name === 'Equity');
  if (!equity || !isTaxReport(sheets.map((sheet) => sheet.name))) throw new Error('not a Dhan tax report');
  const { lots, errors } = collectLots(equity);
  const hints: InstrumentHint[] = [];
  for (const lot of lots) {
    const name = lot.key.name ?? '';
    const isin = lot.key.isin ?? '';
    if (ISIN.test(isin) && !hints.some((hint) => hint.name === name))
      hints.push({ name, isin, line: lot.line });
  }
  const range = equity.rows
    .map((row) => RANGE.exec(texts(row).join(' ')))
    .find((match): match is RegExpExecArray => match !== null);
  return {
    rows: [],
    statements: lots,
    instrumentHints: hints,
    skipped: [],
    errors,
    coverage: range ? { from: range[1] ?? '', to: range[2] ?? '' } : null,
  };
}
