// Zerodha Console tradebook CSV (docs/broker-exports/zerodha/NOTES.md). One row per exchange fill; no product
// column; prices are float32 artefacts (700.599976 for ₹700.60) and are rounded to paise as strings (ADR-0010).
import { normaliseDecimalString, parseDecimalToMicro, parseIstLocal } from '@bhavbook/core';
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

const SEGMENT_SKIP: Readonly<Record<string, SkipReason>> = {
  FO: 'fno',
  NFO: 'fno',
  BFO: 'fno',
  CDS: 'currency',
  BCD: 'currency',
  MCX: 'commodity',
  COM: 'commodity',
  MF: 'mf',
};

type Field = (typeof TRADEBOOK_HEADER)[number];

class RowProblem extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface CsvRecord {
  readonly record: string[];
  readonly info: { readonly lines: number };
  readonly raw: string;
}

export function isTradebookHeader(firstLine: string): boolean {
  return firstLine.replace(/^\uFEFF/, '').trim() === TRADEBOOK_HEADER.join(',');
}

function quantityOf(text: string): bigint {
  const match = /^(\d+)(?:\.0+)?$/.exec(text);
  if (!match) throw new RowProblem(/^\d+\.\d+$/.test(text) ? 'non_integer_quantity' : 'bad_quantity');
  const quantity = BigInt(match[1] ?? '0');
  if (quantity <= 0n) throw new RowProblem('non_positive_quantity');
  return quantity;
}

function priceOf(text: string): bigint {
  try {
    return parseDecimalToMicro(normaliseDecimalString(text, 2, 'half-up'));
  } catch {
    throw new RowProblem('bad_price');
  }
}

function toRow(
  fields: Readonly<Record<Field, string>>,
  line: number,
  raw: string,
  source: CanonicalRow['source'],
): CanonicalRow {
  const side = { buy: 'BUY', sell: 'SELL' }[fields.trade_type.toLowerCase()] as 'BUY' | 'SELL' | undefined;
  if (!side) throw new RowProblem('bad_side');
  const exchange = fields.exchange.toUpperCase();
  if (exchange !== 'NSE' && exchange !== 'BSE') throw new RowProblem('bad_exchange');
  if (!ISO_DATE.test(fields.trade_date)) throw new RowProblem('bad_date');
  if (fields.trade_id === '' || fields.order_id === '') throw new RowProblem('missing_id');
  const quantity = quantityOf(fields.quantity);
  const priceMicro = priceOf(fields.price);
  let executedAtUtc: string;
  try {
    executedAtUtc = parseIstLocal(fields.order_execution_time || fields.trade_date);
  } catch {
    throw new RowProblem('bad_time');
  }
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
  const records = parse(text, {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    info: true,
    raw: true,
  }) as unknown as CsvRecord[]; // with info + raw, csv-parse returns { record, info, raw } objects
  const [header, ...data] = records;
  if (!header || !isTradebookHeader(header.record.join(',')))
    throw new Error('not a Zerodha tradebook (unexpected header)');

  const rows: CanonicalRow[] = [];
  const skipped: ParseResult['skipped'] = [];
  const errors: RowError[] = [];
  for (const { record, info, raw } of data) {
    const line = info.lines;
    if (record.length !== TRADEBOOK_HEADER.length) {
      errors.push({ line, code: 'bad_row' });
      continue;
    }
    const fields = Object.fromEntries(
      TRADEBOOK_HEADER.map((name, index) => [name, (record[index] ?? '').trim()]),
    ) as Record<Field, string>;
    const segment = fields.segment.toUpperCase();
    if (segment !== 'EQ') {
      skipped.push({ line, reason: SEGMENT_SKIP[segment] ?? 'other' });
      continue;
    }
    try {
      rows.push(toRow(fields, line, raw, source));
    } catch (error) {
      if (!(error instanceof RowProblem)) throw error;
      errors.push({ line, code: error.code });
    }
  }
  const dates = rows.map((row) => row.tradeDateIst).sort();
  const coverage = dates.length > 0 ? { from: dates[0] ?? '', to: dates.at(-1) ?? '' } : null;
  return { rows, statements: [], instrumentHints: [], skipped, errors, coverage };
}
