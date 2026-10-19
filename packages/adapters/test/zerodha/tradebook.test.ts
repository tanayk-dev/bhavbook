import { describe, expect, it } from 'vitest';
import { parseResultSchema, zerodhaAdapter, type AdapterInput } from '../../src/index.js';
import { readAgtsEquity } from '../golden/zerodha-agts.js';
import { probeOf, sheetInput, textInput } from '../helpers/fixtures.js';

const HEADER =
  'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';

function csv(...lines: string[]): AdapterInput {
  return { type: 'text', text: [HEADER, ...lines].join('\r\n') + '\r\n' };
}

describe('zerodha tradebook: detection', () => {
  it('recognises the exact tradebook header', () => {
    expect(zerodhaAdapter.detect(probeOf(textInput('zerodha', 'tradebook')))).toEqual({
      kind: 'zerodha.tradebook',
      confidence: 1,
    });
  });

  it('ignores other CSVs, including Dhan trade history', () => {
    expect(zerodhaAdapter.detect(probeOf(textInput('dhan', 'trade_history')))).toBeNull();
    expect(zerodhaAdapter.detect({ type: 'text', head: 'symbol,isin\r\n' })).toBeNull();
  });
});

describe('zerodha tradebook: golden fixture', () => {
  const input = textInput('zerodha', 'tradebook');
  const result = zerodhaAdapter.parse(input, 'zerodha.tradebook');

  it('produces a schema-valid result with 121 fills over 27 symbols', () => {
    expect(() => parseResultSchema.parse(result)).not.toThrow();
    expect(result.rows).toHaveLength(121);
    expect(new Set(result.rows.map((row) => row.brokerSymbol)).size).toBe(27);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('rounds float32 prices to paise (E10: 700.599976 -> 700.60)', () => {
    const fill = result.rows.find((row) => row.raw.text.includes('700.599976'));
    expect(fill?.priceMicro).toBe(700_600_000n);
    expect(fill?.tradeValueMicro).toBe((fill?.quantity ?? 0n) * 700_600_000n);
  });

  it('matches the annual statement (AGTS) exactly for every symbol and exchange', () => {
    const agts = readAgtsEquity(sheetInput('zerodha', 'agts').sheets);
    const sums = new Map<string, { buy: bigint; sell: bigint; buyQty: bigint; sellQty: bigint }>();
    for (const row of result.rows) {
      const key = `${row.brokerSymbol ?? ''}|${row.exchange}`;
      const entry = sums.get(key) ?? { buy: 0n, sell: 0n, buyQty: 0n, sellQty: 0n };
      if (row.side === 'BUY')
        sums.set(key, {
          ...entry,
          buy: entry.buy + row.tradeValueMicro,
          buyQty: entry.buyQty + row.quantity,
        });
      else
        sums.set(key, {
          ...entry,
          sell: entry.sell + row.tradeValueMicro,
          sellQty: entry.sellQty + row.quantity,
        });
    }
    expect(sums.size).toBe(32);
    for (const [key, sum] of sums) {
      const expected = agts.get(key);
      expect(expected, key).toBeDefined();
      expect({ buy: sum.buy, sell: sum.sell, buyQty: sum.buyQty, sellQty: sum.sellQty }, key).toEqual({
        buy: expected?.buyValueMicro,
        sell: expected?.sellValueMicro,
        buyQty: expected?.buyQuantity,
        sellQty: expected?.sellQuantity,
      });
    }
  });

  it('keeps the two blank-ISIN fills as unresolved (null), for S8 to fill in', () => {
    const blank = result.rows.filter((row) => row.isin === null).map((row) => row.brokerSymbol);
    expect(new Set(blank)).toEqual(new Set(['FIVESTAR', 'ADVANCE']));
  });

  it('builds unique, stable dedup keys from exchange, date, order and trade id', () => {
    const keys = result.rows.map((row) => row.dedupKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toMatch(/^zerodha:(NSE|BSE):\d{4}-\d{2}-\d{2}:\d{16,19}:\d+$/);
    expect(zerodhaAdapter.parse(input, 'zerodha.tradebook').rows.map((row) => row.dedupKey)).toEqual(keys);
  });

  it('converts IST execution times to UTC and covers the file date range', () => {
    const first = result.rows.find((row) => row.raw.text.includes('2025-09-12T14:50:01'));
    expect(first?.executedAtUtc).toBe('2025-09-12T09:20:01Z');
    expect(first?.tradeDateIst).toBe('2025-09-12');
    expect(result.coverage).toEqual({ from: '2025-09-12', to: '2026-03-23' });
  });

  it('marks every fill as price-authoritative with no declared product (Zerodha has no product column)', () => {
    expect(result.rows.every((row) => row.valueAuthority === 'price' && row.productDeclared === null)).toBe(
      true,
    );
    expect(result.rows.every((row) => row.granularity === 'fill' && row.source === 'tradebook')).toBe(true);
  });
});

describe('zerodha tradebook: edge cases', () => {
  const good =
    'TCS,INE467B01029,2025-09-12,NSE,EQ,EQ,sell,false,5.000000,3130.600098,606003125,1300000051263375,2025-09-12T14:50:01';

  it('skips non-equity segments with a reason instead of dropping them', () => {
    const result = zerodhaAdapter.parse(
      csv(
        good,
        good.replace(',EQ,EQ,', ',FO,FUT,'),
        good.replace(',EQ,EQ,', ',CDS,FUT,'),
        good.replace(',EQ,EQ,', ',MCX,FUT,'),
      ),
      'zerodha.tradebook',
    );
    expect(result.rows).toHaveLength(1);
    expect(result.skipped).toEqual([
      { line: 3, reason: 'fno' },
      { line: 4, reason: 'currency' },
      { line: 5, reason: 'commodity' },
    ]);
  });

  it.each([
    ['a fractional quantity', good.replace('5.000000', '5.500000'), 'non_integer_quantity'],
    ['a zero quantity', good.replace('5.000000', '0'), 'non_positive_quantity'],
    ['an unknown side', good.replace(',sell,', ',hold,'), 'bad_side'],
    ['an unknown exchange', good.replace(',NSE,', ',MSE,'), 'bad_exchange'],
    ['a malformed price', good.replace('3130.600098', '31.3.0'), 'bad_price'],
    ['a malformed time', good.replace('2025-09-12T14:50:01', 'soon'), 'bad_time'],
    ['a missing trade id', good.replace(',606003125,', ',,'), 'missing_id'],
    ['the wrong column count', 'TCS,INE467B01029', 'bad_row'],
  ])('reports %s as a coded row error, never a cell value', (_label, line, code) => {
    const result = zerodhaAdapter.parse(csv(line), 'zerodha.tradebook');
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([{ line: 2, code }]);
  });

  it('flags auction trades', () => {
    const [row] = zerodhaAdapter.parse(csv(good.replace(',false,', ',true,')), 'zerodha.tradebook').rows;
    expect(row?.flags).toEqual({ auction: true });
  });

  it('parses the external-trades variant with source=external', () => {
    const [row] = zerodhaAdapter.parse(csv(good), 'zerodha.tradebook_external').rows;
    expect(row?.source).toBe('external');
  });

  it('refuses a file whose header is not the tradebook header', () => {
    expect(() => zerodhaAdapter.parse({ type: 'text', text: 'a,b\r\n1,2' }, 'zerodha.tradebook')).toThrow(
      /header/,
    );
  });

  it.todo('golden test on a real "Equity (external trades)" export once a sample exists (PRD §6.3)');
});
