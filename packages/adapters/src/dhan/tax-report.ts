// Dhan Tax Report .xls, Equity sheet (NOTES.md): Dhan's own FIFO lots per section with gross P&L and total charges.
// Statements only; it is the source for lots the trade history lacks (IPO allotments, off-market credits). The
// header block (name, UCC, mobile, email) is never read.
import type { Cell, InstrumentHint, ParseResult, RowError, SheetData, StatementRow } from '../contract.js';
import { cellText, columnIndex, isBlankRow, moneyMicro } from '../cells.js';
import { addHint, ISIN_PATTERN } from '../hints.js';
import { fromDayMonthYear, validIsoDate } from './dates.js';

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
  for (const [column, field] of MONEY) {
    const amount = moneyMicro(at(column), 2);
    // An empty optional amount is null; a present but unreadable one makes the lot bad.
    if (amount === null && cellText(at(column)) !== null) return null;
    data[field] = amount;
  }
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

/** Where the walker is in the sheet. Only the preamble (header block, summary table) is ignored. */
type Mode =
  | { readonly kind: 'preamble' }
  | { readonly kind: 'lots'; readonly section: string; readonly columns: Map<string, number> | null }
  | { readonly kind: 'holdings' }
  | { readonly kind: 'unknown' };

const FOOTER = 'This is a system generated report';

interface Collected {
  readonly lots: StatementRow[];
  readonly skipped: ParseResult['skipped'];
  readonly errors: RowError[];
}

function titleMode(title: string, line: number, out: Collected): Mode {
  const section = title.startsWith(SECTION_PREFIX) ? sectionOf(title) : { known: false, section: null };
  if (!section.known) {
    out.errors.push({ line, code: 'unknown_section' });
    return { kind: 'unknown' };
  }
  return section.section === null
    ? { kind: 'holdings' }
    : { kind: 'lots', section: section.section, columns: null };
}

function headerMode(mode: Mode & { kind: 'lots' }, row: readonly Cell[], line: number, out: Collected): Mode {
  const columns = columnIndex(row);
  if (REQUIRED.every((name) => columns.has(name))) return { ...mode, columns };
  out.errors.push({ line, code: 'bad_header' });
  return { ...mode, columns: null };
}

/**
 * Walks the Equity sheet: an `Equity Segment - ...` title starts a section and a `Sr.` row is its header. Inside a
 * lot section every other row is a lot or a `bad_lot` error; Free Holdings rows are skipped; rows under an unknown
 * title are errors. Reading stops at the footer. Nothing after the first title is ignored silently.
 */
function collectLots(sheet: SheetData): Collected {
  const out: Collected = { lots: [], skipped: [], errors: [] };
  const seen = new Map<string, number>();
  let mode: Mode = { kind: 'preamble' };
  for (const [index, row] of sheet.rows.entries()) {
    const line = index + 1;
    if (isBlankRow(row)) continue;
    const cells = texts(row);
    const first = cells[0] ?? '';
    if (cells.length === 1 && first.startsWith(FOOTER)) break;
    if (cells.length === 1 && first.toLowerCase().startsWith('equity segment')) {
      mode = titleMode(first, line, out);
      continue;
    }
    if (mode.kind === 'preamble' || first === 'Sr.') {
      if (mode.kind === 'lots' && first === 'Sr.') mode = headerMode(mode, row, line, out);
      continue;
    }
    if (mode.kind === 'holdings') {
      out.skipped.push({ line, reason: 'other' });
      continue;
    }
    const lot =
      mode.kind === 'lots' && mode.columns !== null ? lotOf(row, mode.columns, mode.section, line) : null;
    if (lot === null) {
      out.errors.push({ line, code: 'bad_lot' });
      continue;
    }
    const count = (seen.get(lot.dedupKey) ?? 0) + 1;
    seen.set(lot.dedupKey, count);
    out.lots.push({ ...lot, dedupKey: `${lot.dedupKey}#${String(count)}` });
  }
  return out;
}

export function parseTaxReport(sheets: readonly SheetData[]): ParseResult {
  const equity = sheets.find((sheet) => sheet.name === 'Equity');
  if (!equity || !isTaxReport(sheets.map((sheet) => sheet.name))) throw new Error('not a Dhan tax report');
  const { lots, skipped, errors } = collectLots(equity);
  const hints: InstrumentHint[] = [];
  for (const lot of lots) {
    const isin = lot.key.isin ?? '';
    if (ISIN_PATTERN.test(isin)) addHint(hints, errors, { name: lot.key.name ?? '', isin, line: lot.line });
  }
  const range = equity.rows
    .map((row) => RANGE.exec(texts(row).join(' ')))
    .find((match): match is RegExpExecArray => match !== null);
  const from = validIsoDate(range?.[1] ?? '');
  const to = validIsoDate(range?.[2] ?? '');
  return {
    rows: [],
    statements: lots,
    instrumentHints: hints,
    skipped,
    errors: errors.sort((a, b) => a.line - b.line),
    coverage: from && to ? { from, to } : null,
  };
}
