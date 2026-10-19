// Zerodha Console tax P&L XLSX (NOTES.md): per-FIFO-lot charges to 4 dp (golden data for reconciliation) and DP
// charges per sale. Statements only; it never produces trade rows. Header blocks (client ID, name, PAN) are skipped.
import { istDayBounds } from '@bhavbook/core';
import type { Cell, InstrumentHint, ParseResult, SheetData, SkipReason, StatementRow } from '../contract.js';
import { cellText, columnIndex, ISO_DATE, isBlankRow, moneyMicro } from '../cells.js';

const SECTIONS: Readonly<
  Record<string, { kind: 'lot'; section: string } | { kind: 'skip'; reason: SkipReason }>
> = {
  'Equity - Intraday': { kind: 'lot', section: 'intraday' },
  'Equity - Short Term': { kind: 'lot', section: 'short_term' },
  'Equity - Long Term': { kind: 'lot', section: 'long_term' },
  'Equity - Buyback': { kind: 'lot', section: 'buyback' },
  'Mutual Funds': { kind: 'skip', reason: 'mf' },
  'F&O': { kind: 'skip', reason: 'fno' },
  Currency: { kind: 'skip', reason: 'currency' },
  Commodity: { kind: 'skip', reason: 'commodity' },
};

/** Money columns (4 dp) → data field names. */
const MONEY_COLUMNS: readonly (readonly [string, string])[] = [
  ['Buy Value', 'buy_value_micro'],
  ['Sell Value', 'sell_value_micro'],
  ['Profit', 'profit_micro'],
  ['Fair Market Value', 'fair_market_value_micro'],
  ['Taxable Profit', 'taxable_profit_micro'],
  ['Turnover', 'turnover_micro'],
  ['Brokerage', 'brokerage_micro'],
  ['Exchange Transaction Charges', 'exchange_txn_micro'],
  ['IPFT', 'ipft_micro'],
  ['SEBI Charges', 'sebi_micro'],
  ['CGST', 'cgst_micro'],
  ['SGST', 'sgst_micro'],
  ['IGST', 'igst_micro'],
  ['Stamp Duty', 'stamp_duty_micro'],
  ['STT', 'stt_micro'],
];

const DP_ROW = /^DP Charges for Sale of (\S+) on (\d{2})\/(\d{2})\/(\d{4})$/;
const RANGE = /from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/;

export function isTaxPnl(sheetNames: readonly string[]): boolean {
  return (
    sheetNames.some((name) => name.startsWith('Tradewise Exits from')) &&
    sheetNames.includes('Equity and Non Equity')
  );
}

function singleText(row: readonly Cell[]): string | null {
  const texts = row.map(cellText).filter((text): text is string => text !== null);
  return texts.length === 1 ? (texts[0] ?? null) : null;
}

class Occurrences {
  private readonly seen = new Map<string, number>();
  next(key: string): string {
    const count = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, count);
    return `${key}#${String(count)}`;
  }
}

interface Collected {
  readonly statements: StatementRow[];
  readonly hints: InstrumentHint[];
  readonly skipped: ParseResult['skipped'];
  readonly errors: ParseResult['errors'];
}

function lotRow(
  row: readonly Cell[],
  columns: Map<string, number>,
  section: string,
  line: number,
): StatementRow | null {
  const at = (name: string): Cell | undefined => row[columns.get(name) ?? -1];
  const symbol = cellText(at('Symbol'));
  const isin = cellText(at('ISIN'));
  const entry = cellText(at('Entry Date'));
  const exit = cellText(at('Exit Date'));
  const quantity = cellText(at('Quantity'));
  if (
    !symbol ||
    !entry ||
    !exit ||
    !quantity ||
    !ISO_DATE.test(entry) ||
    !ISO_DATE.test(exit) ||
    !/^\d+$/.test(quantity)
  ) {
    return null;
  }
  const data: Record<string, bigint | string | null> = { holding_days: cellText(at('Period of Holding')) };
  for (const [column, field] of MONEY_COLUMNS) data[field] = moneyMicro(at(column), 4);
  if (data.buy_value_micro === null || data.sell_value_micro === null) return null;
  const key = { section, symbol, isin: isin ?? '', entry_date: entry, exit_date: exit, quantity };
  const identity = [
    section,
    isin ?? symbol,
    entry,
    exit,
    quantity,
    String(data.buy_value_micro),
    String(data.sell_value_micro),
  ].join('|');
  return { kind: 'zerodha.tax_pnl.lot', dedupKey: identity, key, data, line };
}

/** Columns every lot table must have (the money columns are read when present). */
const REQUIRED_LOT_COLUMNS = [
  'Symbol',
  'ISIN',
  'Entry Date',
  'Exit Date',
  'Quantity',
  'Buy Value',
  'Sell Value',
];

function addLot(lot: StatementRow, out: Collected, occurrences: Occurrences): void {
  out.statements.push({ ...lot, dedupKey: occurrences.next(lot.dedupKey) });
  const isin = lot.key.isin ?? '';
  if (/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin) && !out.hints.some((hint) => hint.name === lot.key.symbol)) {
    out.hints.push({ name: lot.key.symbol ?? '', isin, line: lot.line });
  }
}

/**
 * Walks the Tradewise sheet: a single-cell title starts a section, a row starting with "Symbol" is its header, and
 * every other non-blank row is a lot (or a skipped non-equity row). Blank rows never end a table; an unknown title
 * ends the current section and is reported, so rows are never silently mislabelled or dropped.
 */
function collectLots(sheet: SheetData, out: Collected, occurrences: Occurrences): void {
  let mode: (typeof SECTIONS)[string] | null = null;
  let columns: Map<string, number> | null = null;
  for (const [index, row] of sheet.rows.entries()) {
    const line = index + 1;
    if (isBlankRow(row)) continue;
    const title = singleText(row);
    if (title !== null && Object.hasOwn(SECTIONS, title)) {
      mode = SECTIONS[title] ?? null;
      columns = null;
      continue;
    }
    if (mode === null) continue;
    if (title !== null && cellText(row.find((cell) => cellText(cell) !== null)) !== 'Symbol') {
      out.errors.push({ line, code: 'unknown_section' });
      mode = null;
      columns = null;
      continue;
    }
    if (cellText(row.find((cell) => cellText(cell) !== null)) === 'Symbol') {
      columns = columnIndex(row);
      if (mode.kind === 'lot' && REQUIRED_LOT_COLUMNS.some((name) => !columns?.has(name))) {
        out.errors.push({ line, code: 'bad_header' });
        columns = null;
      }
      continue;
    }
    if (mode.kind === 'skip') {
      out.skipped.push({ line, reason: mode.reason });
      continue;
    }
    const lot = columns === null ? null : lotRow(row, columns, mode.section, line);
    if (lot === null) out.errors.push({ line, code: 'bad_lot' });
    else addLot(lot, out, occurrences);
  }
}

function dpSaleDate(day: string, month: string, year: string): string | null {
  const date = `${year}-${month}-${day}`;
  try {
    istDayBounds(date); // rejects impossible calendar dates
    return date;
  } catch {
    return null;
  }
}

function collectDpCharges(sheet: SheetData, out: Collected, occurrences: Occurrences): void {
  let columns: Map<string, number> | null = null;
  for (const [index, row] of sheet.rows.entries()) {
    if (row.some((cell) => cellText(cell) === 'Particulars')) {
      columns = columnIndex(row);
      continue;
    }
    if (columns === null) continue;
    const particulars = cellText(row[columns.get('Particulars') ?? -1]) ?? '';
    if (!particulars.startsWith('DP Charges')) continue;
    const match = DP_ROW.exec(particulars);
    const [, symbol = '', day = '', month = '', year = ''] = match ?? [];
    const saleDate = match ? dpSaleDate(day, month, year) : null;
    const amount = moneyMicro(row[columns.get('Debit') ?? -1], 2);
    if (saleDate === null || amount === null) {
      out.errors.push({ line: index + 1, code: 'bad_dp_row' });
      continue;
    }
    out.statements.push({
      kind: 'zerodha.tax_pnl.dp',
      dedupKey: occurrences.next(`dp|${symbol}|${saleDate}`),
      key: { symbol, sale_date: saleDate },
      data: { amount_micro: amount },
      line: index + 1,
    });
  }
}

export function parseTaxPnl(sheets: readonly SheetData[]): ParseResult {
  const tradewise = sheets.find((sheet) => sheet.name.startsWith('Tradewise Exits from'));
  if (!tradewise) throw new Error('not a Zerodha tax P&L (no Tradewise Exits sheet)');
  const out: Collected = { statements: [], hints: [], skipped: [], errors: [] };
  const occurrences = new Occurrences();
  collectLots(tradewise, out, occurrences);
  const other = sheets.find((sheet) => sheet.name === 'Other Debits and Credits');
  if (other) collectDpCharges(other, out, occurrences);

  const titleRange = tradewise.rows
    .map((row) => RANGE.exec(singleText(row) ?? ''))
    .find((match): match is RegExpExecArray => match !== null);
  const coverage = titleRange ? { from: titleRange[1] ?? '', to: titleRange[2] ?? '' } : null;
  return {
    rows: [],
    statements: out.statements,
    instrumentHints: out.hints,
    skipped: out.skipped,
    errors: out.errors,
    coverage,
  };
}
