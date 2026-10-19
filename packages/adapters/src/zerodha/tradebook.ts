// Zerodha Console tradebook CSV (docs/broker-exports/zerodha/NOTES.md). One row per exchange fill; no product
// column; prices are float32 artefacts (700.599976 for ₹700.60) and are rounded to paise as strings (ADR-0010).
// Columns are matched by name (case- and quote-insensitive), so exports with extra columns (F&O) still parse.
import {
  istDateOf,
  istDayBounds,
  normaliseDecimalString,
  parseDecimalToMicro,
  parseIstLocal,
} from '@bhavbook/core';
import { parse } from 'csv-parse/sync';
import type { CanonicalRow, ParseResult, RowError, SkipReason } from '../contract.js';
import { ISO_DATE } from '../cells.js';

export const TRADEBOOK_HEADER = [
  'symbol',
  'isin',
  'trade_date',
  'exchange',
  'segment',
  'series',
  'trade_type',
  'auction',
  'quantity',
  'price',
  'trade_id',
  'order_id',
  'order_execution_time',
] as const;

type Field = (typeof TRADEBOOK_HEADER)[number];
type Fields = Readonly<Record<Field, string>>;

const SEGMENT_SKIP: ReadonlyMap<string, SkipReason> = new Map([
  ['FO', 'fno'],
  ['NFO', 'fno'],
  ['BFO', 'fno'],
  ['CDS', 'currency'],
  ['BCD', 'currency'],
  ['MCX', 'commodity'],
  ['COM', 'commodity'],
  ['MF', 'mf'],
]);

class RowProblem extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface CsvRecord {
  readonly record: readonly string[];
  readonly line: number;
  readonly raw: string;
}

function normaliseName(name: string): string {
  return name
    .replace(/^\uFEFF/, '')
    .replace(/^"|"$/g, '')
    .trim()
    .toLowerCase();
}

/** Column positions of every required field, or null when the header lacks one. */
function headerColumns(header: readonly string[]): ReadonlyMap<Field, number> | null {
  const names = header.map(normaliseName);
  const columns = new Map<Field, number>();
  for (const field of TRADEBOOK_HEADER) {
    const index = names.indexOf(field);
    if (index === -1) return null;
    columns.set(field, index);
  }
  return columns;
}

/** 1 for the exact Console header, 0.9 for a header with extra columns (e.g. F&O exports), else 0. */
export function tradebookHeaderConfidence(firstLine: string): number {
  const names = firstLine.split(',').map(normaliseName);
  if (names.join(',') === TRADEBOOK_HEADER.join(',')) return 1;
  return headerColumns(names) === null ? 0 : 0.9;
}

/** csv-parse can quote cell content in its error messages; never let that escape (ADR-0019). */
function readRecords(text: string): CsvRecord[] {
  let parsed: unknown;
  try {
    parsed = parse(text, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      info: true,
      raw: true,
    });
  } catch {
    throw new Error('malformed CSV');
  }
  if (!Array.isArray(parsed)) throw new Error('malformed CSV');
  return parsed.map((entry: unknown) => {
    const value = entry as { record?: unknown; info?: { lines?: unknown }; raw?: unknown };
    if (
      !Array.isArray(value.record) ||
      typeof value.info?.lines !== 'number' ||
      typeof value.raw !== 'string'
    ) {
      throw new Error('malformed CSV');
    }
    return { record: value.record.map(String), line: value.info.lines, raw: value.raw };
  });
}

function fieldsOf(record: readonly string[], columns: ReadonlyMap<Field, number>): Fields {
  const entries = TRADEBOOK_HEADER.map((field): [Field, string] => [
    field,
    (record[columns.get(field) ?? -1] ?? '').trim(),
  ]);
  return Object.fromEntries(entries) as Record<Field, string>;
}

function quantityOf(text: string): bigint {
  const match = /^(\d+)(?:\.0+)?$/.exec(text);
  if (!match) throw new RowProblem(/^\d+\.\d+$/.test(text) ? 'non_integer_quantity' : 'bad_quantity');
  const quantity = BigInt(match[1] ?? '0');
  if (quantity <= 0n) throw new RowProblem('non_positive_quantity');
  return quantity;
}

function priceOf(text: string): bigint {
  let price: bigint;
  try {
    price = parseDecimalToMicro(normaliseDecimalString(text, 2, 'half-up'));
  } catch {
    throw new RowProblem('bad_price');
  }
  if (price <= 0n) throw new RowProblem('non_positive_price');
  return price;
}

function sideOf(text: string): 'BUY' | 'SELL' {
  const side = text.toLowerCase();
  if (side === 'buy') return 'BUY';
  if (side === 'sell') return 'SELL';
  throw new RowProblem('bad_side');
}

function exchangeOf(text: string): 'NSE' | 'BSE' {
  const exchange = text.toUpperCase();
  if (exchange === 'NSE' || exchange === 'BSE') return exchange;
  throw new RowProblem('bad_exchange');
}

function timesOf(tradeDate: string, executionTime: string): string {
  try {
    if (!ISO_DATE.test(tradeDate)) throw new Error('date');
    istDayBounds(tradeDate); // throws on impossible calendar dates
  } catch {
    throw new RowProblem('bad_date');
  }
  let executedAtUtc: string;
  try {
    if (executionTime === '') throw new Error('time');
    executedAtUtc = parseIstLocal(executionTime);
  } catch {
    throw new RowProblem('bad_time');
  }
  if (istDateOf(executedAtUtc) !== tradeDate) throw new RowProblem('date_mismatch');
  return executedAtUtc;
}

function toRow(fields: Fields, line: number, raw: string, source: CanonicalRow['source']): CanonicalRow {
  const side = sideOf(fields.trade_type);
  const exchange = exchangeOf(fields.exchange);
  const executedAtUtc = timesOf(fields.trade_date, fields.order_execution_time);
  if (fields.trade_id === '' || fields.order_id === '') throw new RowProblem('missing_id');
  const quantity = quantityOf(fields.quantity);
  const priceMicro = priceOf(fields.price);
  return {
    dedupKey: `zerodha:${exchange}:${fields.trade_date}:${fields.order_id}:${fields.trade_id}`,
    granularity: 'fill',
    source,
    externalOrderId: fields.order_id,
    executedAtUtc,
    tradeDateIst: fields.trade_date,
    side,
    quantity,
    priceMicro,
    tradeValueMicro: quantity * priceMicro,
    valueAuthority: 'price',
    exchange,
    isin: fields.isin === '' ? null : fields.isin,
    brokerSymbol: fields.symbol === '' ? null : fields.symbol,
    brokerName: null,
    productDeclared: null,
    flags: { auction: fields.auction.toLowerCase() === 'true' },
    raw: { line, text: raw.replace(/\r?\n$/, '') },
  };
}

export function parseTradebook(text: string, source: CanonicalRow['source']): ParseResult {
  const records = readRecords(text).filter((entry) => entry.record.some((cell) => cell.trim() !== ''));
  const [header, ...data] = records;
  const columns = header ? headerColumns(header.record) : null;
  if (!columns || !header) throw new Error('not a Zerodha tradebook (unexpected header)');

  const rows: CanonicalRow[] = [];
  const skipped: ParseResult['skipped'] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();
  for (const { record, line, raw } of data) {
    if (record.length < header.record.length) {
      errors.push({ line, code: 'bad_row' });
      continue;
    }
    const fields = fieldsOf(record, columns);
    const segment = fields.segment.toUpperCase();
    if (segment !== 'EQ') {
      skipped.push({ line, reason: SEGMENT_SKIP.get(segment) ?? 'other' });
      continue;
    }
    try {
      const row = toRow(fields, line, raw, source);
      if (seen.has(row.dedupKey)) throw new RowProblem('duplicate_row');
      seen.add(row.dedupKey);
      rows.push(row);
    } catch (error) {
      if (!(error instanceof RowProblem)) throw error;
      errors.push({ line, code: error.code });
    }
  }
  const dates = rows.map((row) => row.tradeDateIst).sort();
  const [from] = dates;
  const to = dates.at(-1);
  return {
    rows,
    statements: [],
    instrumentHints: [],
    skipped,
    errors,
    coverage: from && to ? { from, to } : null,
  };
}
