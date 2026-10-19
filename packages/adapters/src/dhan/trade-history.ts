// Dhan "All Exchange Transactions" trade history CSV (docs/broker-exports/dhan/NOTES.md). One row per order (Dhan
// aggregates fills), no ISIN, no order id. Trade Value is the broker's truth and Trade Price is display-rounded
// (E9: 11 x 891.97 != 9811.70), so the price is derived from the value (ADR-0008).
import { createHash } from 'node:crypto';
import { divRound, normaliseDecimalString, parseDecimalToMicro, parseIstLocal } from '@bhavbook/core';
import type { CanonicalRow, ParseResult, RowError, SkipReason } from '../contract.js';
import { isBlankRecord, readCsvRecords } from '../csv.js';
import { validIsoDate } from './dates.js';

export const TRADE_HISTORY_HEADER =
  'Date,Time,Name,Buy/Sell,Order,Exchange,Segment,Quantity/Lot,Trade Price,Trade Value,Status';
const COLUMNS = TRADE_HISTORY_HEADER.split(',').length;

const SEGMENT_SKIP: ReadonlyMap<string, SkipReason> = new Map([
  ['derivatives', 'fno'],
  ['currency', 'currency'],
  ['commodity', 'commodity'],
]);

const PRODUCTS: ReadonlyMap<string, NonNullable<CanonicalRow['productDeclared']>> = new Map([
  ['DELIVERY', 'DELIVERY'],
  ['INTRADAY', 'INTRADAY'],
  ['MTF', 'MTF'],
]);

/** Statuses of orders that produced no trade; any other status than `Traded` is reported, never guessed. */
const NOT_TRADED: ReadonlySet<string> = new Set(['rejected', 'cancelled', 'canceled', 'pending', 'expired']);

class RowProblem extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface Fields {
  readonly date: string;
  readonly time: string;
  readonly name: string;
  readonly side: string;
  readonly order: string;
  readonly exchange: string;
  readonly segment: string;
  readonly quantity: string;
  readonly value: string;
  readonly status: string;
}

function fieldsOf(record: readonly string[]): Fields {
  const [date = '', time = '', name = '', side = '', order = '', exchange = '', segment = '', quantity = ''] =
    record.map((cell) => cell.trim());
  return {
    date,
    time,
    name,
    side,
    order,
    exchange,
    segment,
    quantity,
    value: record[9]?.trim() ?? '',
    status: record[10]?.trim() ?? '',
  };
}

function quantityOf(text: string): bigint {
  if (/^\d+\.\d*[1-9]\d*$/.test(text)) throw new RowProblem('non_integer_quantity');
  const match = /^(\d+)(?:\.0*)?$/.exec(text);
  if (!match) throw new RowProblem('bad_quantity');
  const quantity = BigInt(match[1] ?? '0');
  if (quantity <= 0n) throw new RowProblem('non_positive_quantity');
  return quantity;
}

function valueOf(text: string): bigint {
  let value: bigint;
  try {
    value = parseDecimalToMicro(normaliseDecimalString(text, 2, 'half-up'));
  } catch {
    throw new RowProblem('bad_value');
  }
  if (value <= 0n) throw new RowProblem('non_positive_value');
  return value;
}

function sideOf(text: string): 'BUY' | 'SELL' {
  const side = text.toUpperCase();
  if (side === 'BUY' || side === 'SELL') return side;
  throw new RowProblem('bad_side');
}

function exchangeOf(text: string): 'NSE' | 'BSE' {
  const exchange = text.toUpperCase();
  if (exchange === 'NSE' || exchange === 'BSE') return exchange;
  throw new RowProblem('bad_exchange');
}

function executedAtOf(date: string, time: string): string {
  if (validIsoDate(date) === null) throw new RowProblem('bad_date');
  try {
    return parseIstLocal(`${date}T${time}`);
  } catch {
    throw new RowProblem('bad_time');
  }
}

/**
 * ADR-0009: sha256 of the identifying fields, taken from the parsed row (not the raw text) so `200` / `200.0` or
 * `9811.7` / `9811.70` in another export give the same key. The caller appends the occurrence index.
 */
function identityOf(row: Omit<CanonicalRow, 'dedupKey'>): string {
  const tuple = [
    row.executedAtUtc,
    row.brokerName ?? '',
    row.side,
    row.productDeclared ?? '',
    row.exchange,
    row.quantity.toString(),
    row.tradeValueMicro.toString(),
  ];
  return `dhan:${createHash('sha256').update(tuple.join('|')).digest('hex')}`;
}

function toRow(fields: Fields, line: number, raw: string): Omit<CanonicalRow, 'dedupKey'> {
  const executedAtUtc = executedAtOf(fields.date, fields.time);
  if (fields.name === '') throw new RowProblem('missing_name');
  const side = sideOf(fields.side);
  const productDeclared = PRODUCTS.get(fields.order.toUpperCase());
  if (productDeclared === undefined) throw new RowProblem('bad_product');
  const exchange = exchangeOf(fields.exchange);
  const quantity = quantityOf(fields.quantity);
  const tradeValueMicro = valueOf(fields.value);
  return {
    granularity: 'order',
    source: 'tradebook',
    externalOrderId: null,
    executedAtUtc,
    tradeDateIst: fields.date,
    side,
    quantity,
    priceMicro: divRound(tradeValueMicro, quantity, 'half-up'),
    tradeValueMicro,
    valueAuthority: 'value',
    exchange,
    isin: null,
    brokerSymbol: null,
    brokerName: fields.name,
    productDeclared,
    flags: {},
    raw: { line, text: raw },
  };
}

export function isTradeHistoryHeader(firstLine: string): boolean {
  return firstLine.replace(/^\uFEFF/, '').trim() === TRADE_HISTORY_HEADER;
}

export function parseTradeHistory(text: string): ParseResult {
  const [header, ...data] = readCsvRecords(text).filter((entry) => !isBlankRecord(entry.record));
  if (!header || !isTradeHistoryHeader(header.record.join(','))) {
    throw new Error('not a Dhan trade history (unexpected header)');
  }
  const rows: CanonicalRow[] = [];
  const skipped: ParseResult['skipped'] = [];
  const errors: RowError[] = [];
  const occurrences = new Map<string, number>();
  for (const { record, line, raw } of data) {
    if (record.length < COLUMNS) {
      errors.push({ line, code: 'bad_row' });
      continue;
    }
    const fields = fieldsOf(record);
    const status = fields.status.toLowerCase();
    if (NOT_TRADED.has(status)) {
      skipped.push({ line, reason: 'not_traded' });
      continue;
    }
    if (status !== 'traded') {
      errors.push({ line, code: 'unknown_status' });
      continue;
    }
    if (fields.segment.toLowerCase() !== 'equity') {
      skipped.push({ line, reason: SEGMENT_SKIP.get(fields.segment.toLowerCase()) ?? 'other' });
      continue;
    }
    try {
      const row = toRow(fields, line, raw);
      const identity = identityOf(row);
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      rows.push({ ...row, dedupKey: `${identity}#${String(occurrence)}` });
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
