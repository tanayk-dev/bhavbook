import { describe, expect, it } from 'vitest';
import { dhanAdapter, parseResultSchema, zerodhaAdapter, type AdapterInput } from '../../src/index.js';
import { probeOf, textInput } from '../helpers/fixtures.js';

const HEADER = 'Date,Time,Name,Buy/Sell,Order,Exchange,Segment,Quantity/Lot,Trade Price,Trade Value,Status';
const GOOD = '2024-09-18,09:16:45,Bajaj Housing Finance,SELL,DELIVERY,NSE,Equity,200,174.05,34810.00,Traded';

function csv(...lines: string[]): AdapterInput {
  return { type: 'text', text: [HEADER, ...lines].join('\r\n') };
}

describe('dhan trade history: detection', () => {
  it('recognises the All Exchange Transactions header', () => {
    expect(dhanAdapter.detect(probeOf(textInput('dhan', 'trade_history')))).toEqual({
      kind: 'dhan.trade_history',
      confidence: 1,
    });
  });

  it('does not claim Zerodha files, and Zerodha does not claim Dhan files', () => {
    expect(dhanAdapter.detect(probeOf(textInput('zerodha', 'tradebook')))).toBeNull();
    expect(zerodhaAdapter.detect(probeOf(textInput('dhan', 'trade_history')))).toBeNull();
  });
});

describe('dhan trade history: golden fixture', () => {
  const result = dhanAdapter.parse(textInput('dhan', 'trade_history'), 'dhan.trade_history');

  it('produces a schema-valid result with 116 rows over 42 names', () => {
    expect(() => parseResultSchema.parse(result)).not.toThrow();
    expect(result.rows).toHaveLength(116);
    expect(new Set(result.rows.map((row) => row.brokerName)).size).toBe(42);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('treats Trade Value as the truth (E9: 11 x 891.97 != 9811.70)', () => {
    const row = result.rows.find((candidate) => candidate.raw.text.includes(',891.97,'));
    expect(row?.tradeValueMicro).toBe(9_811_700_000n);
    expect(row?.valueAuthority).toBe('value');
    expect(row?.priceMicro).toBe(891_972_727n);
  });

  it('keeps distinct keys for repeated (day, scrip, side) orders and none duplicate', () => {
    const keys = result.rows.map((row) => row.dedupKey);
    expect(new Set(keys).size).toBe(keys.length);
    const groups = new Map<string, number>();
    for (const row of result.rows) {
      const group = `${row.tradeDateIst}|${row.brokerName ?? ''}|${row.side}`;
      groups.set(group, (groups.get(group) ?? 0) + 1);
    }
    expect([...groups.values()].filter((count) => count > 1)).toHaveLength(8);
  });

  it('maps the Order column to the declared product, including MTF', () => {
    const products = new Map<string, number>();
    for (const row of result.rows)
      products.set(row.productDeclared ?? 'null', (products.get(row.productDeclared ?? 'null') ?? 0) + 1);
    expect(Object.fromEntries(products)).toEqual({ DELIVERY: 106, INTRADAY: 8, MTF: 2 });
  });

  it('has no ISIN or order id (Dhan exports none) and covers the whole history', () => {
    expect(result.rows.every((row) => row.isin === null && row.externalOrderId === null)).toBe(true);
    expect(result.rows.every((row) => row.granularity === 'order')).toBe(true);
    expect(result.coverage).toEqual({ from: '2024-04-22', to: '2026-10-15' });
  });

  it('converts IST date + time to UTC', () => {
    const row = result.rows.find((candidate) => candidate.raw.text.startsWith('2024-09-18,09:16:45'));
    expect(row?.executedAtUtc).toBe('2024-09-18T03:46:45Z');
  });

  it('stores raw rows without line endings (CRLF files included)', () => {
    const zerodha = zerodhaAdapter.parse(textInput('zerodha', 'tradebook'), 'zerodha.tradebook');
    for (const row of [...result.rows, ...zerodha.rows]) expect(row.raw.text).not.toMatch(/[\r\n]/);
  });

  it('is stable across re-parses (idempotent keys)', () => {
    const again = dhanAdapter.parse(textInput('dhan', 'trade_history'), 'dhan.trade_history');
    expect(again.rows.map((row) => row.dedupKey)).toEqual(result.rows.map((row) => row.dedupKey));
  });
});

describe('dhan trade history: edge cases', () => {
  it('numbers identical orders by occurrence so both survive', () => {
    const result = dhanAdapter.parse(csv(GOOD, GOOD), 'dhan.trade_history');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.dedupKey).not.toBe(result.rows[1]?.dedupKey);
    expect(result.rows[0]?.dedupKey.endsWith('#1')).toBe(true);
  });

  it('skips orders that were not traded and non-equity segments', () => {
    const result = dhanAdapter.parse(
      csv(GOOD.replace(',Traded', ',Rejected'), GOOD.replace(',Equity,', ',Derivatives,'), GOOD),
      'dhan.trade_history',
    );
    expect(result.skipped).toEqual([
      { line: 2, reason: 'not_traded' },
      { line: 3, reason: 'fno' },
    ]);
    expect(result.rows).toHaveLength(1);
  });

  it.each([
    ['an unknown side', GOOD.replace(',SELL,', ',HOLD,'), 'bad_side'],
    ['an unknown product', GOOD.replace(',DELIVERY,', ',CO,'), 'bad_product'],
    ['an unknown exchange', GOOD.replace(',NSE,', ',MSE,'), 'bad_exchange'],
    ['a fractional quantity', GOOD.replace(',200,', ',2.5,'), 'non_integer_quantity'],
    ['a zero value', GOOD.replace(',34810.00,', ',0.00,'), 'non_positive_value'],
    ['an impossible date', GOOD.replace('2024-09-18', '2024-02-30'), 'bad_date'],
    ['a missing name', GOOD.replace('Bajaj Housing Finance', ''), 'missing_name'],
    ['a short row', '2024-09-18,09:16:45', 'bad_row'],
  ])('reports %s as a coded error', (_label, line, code) => {
    expect(dhanAdapter.parse(csv(line), 'dhan.trade_history').errors).toEqual([{ line: 2, code }]);
  });

  it('turns CSV syntax errors into a fixed message', () => {
    expect(() =>
      dhanAdapter.parse({ type: 'text', text: `${HEADER}\r\n"SECRET,x` }, 'dhan.trade_history'),
    ).toThrow(/^malformed CSV$/);
  });
});
