import { describe, expect, it } from 'vitest';
import {
  canonicalRowSchema,
  detectReport,
  parseResultSchema,
  type BrokerAdapter,
  type CanonicalRow,
  type FileProbe,
  type ParseResult,
} from '../src/index.js';

const row: CanonicalRow = {
  dedupKey: 'zerodha:NSE:2025-09-12:1300000051263385:606003128',
  granularity: 'fill',
  source: 'tradebook',
  externalOrderId: '1300000051263385',
  executedAtUtc: '2025-09-12T09:20:01Z',
  tradeDateIst: '2025-09-12',
  side: 'SELL',
  quantity: 10n,
  priceMicro: 700_600_000n,
  tradeValueMicro: 7_006_000_000n,
  valueAuthority: 'price',
  exchange: 'NSE',
  isin: 'INE142M01025',
  brokerSymbol: 'TATATECH',
  brokerName: null,
  productDeclared: null,
  flags: { auction: false },
  raw: { line: 2, text: 'TATATECH,INE142M01025,…' },
};

const result: ParseResult = {
  rows: [row],
  statements: [],
  instrumentHints: [],
  skipped: [{ line: 3, reason: 'fno' }],
  errors: [{ line: 4, code: 'non_integer_qty' }],
  coverage: { from: '2025-09-12', to: '2026-03-23' },
};

describe('canonical row schema', () => {
  it('accepts a well-formed row', () => {
    expect(canonicalRowSchema.parse(row)).toEqual(row);
  });

  it.each([
    ['money as a float', { priceMicro: 700.6 }],
    ['a zero quantity', { quantity: 0n }],
    ['an unknown side', { side: 'HOLD' }],
    ['a malformed ISIN', { isin: 'INE142' }],
    ['a non-UTC timestamp', { executedAtUtc: '2025-09-12T14:50:01' }],
    ['a malformed IST date', { tradeDateIst: '12-09-2025' }],
    ['an empty dedup key', { dedupKey: '' }],
  ])('rejects %s', (_label, change) => {
    expect(canonicalRowSchema.safeParse({ ...row, ...change }).success).toBe(false);
  });
});

describe('parse result schema', () => {
  it('accepts a full result', () => {
    expect(parseResultSchema.parse(result)).toEqual(result);
  });

  it('rejects an error that carries a cell value (errors hold a code only)', () => {
    const leaky = { ...result, errors: [{ line: 4, code: 'bad', value: 'TEST USER' }] };
    expect(parseResultSchema.safeParse(leaky).success).toBe(false);
  });

  it('rejects an unknown skip reason', () => {
    expect(parseResultSchema.safeParse({ ...result, skipped: [{ line: 1, reason: 'boring' }] }).success).toBe(
      false,
    );
  });
});

function fakeAdapter(broker: 'zerodha' | 'dhan', kind: string, confidence: number | null): BrokerAdapter {
  return {
    broker,
    version: '1',
    reportKinds: [kind],
    rejectedKinds: [{ kind: `${broker}.pnl`, message: 'P&L reports are not needed in v1' }],
    detect: () => (confidence === null ? null : { kind, confidence }),
    parse: () => result,
  };
}

describe('detectReport', () => {
  const probe: FileProbe = { type: 'text', head: 'symbol,isin,trade_date' };

  it('returns candidates best first', () => {
    const candidates = detectReport(
      [fakeAdapter('dhan', 'dhan.x', 0.4), fakeAdapter('zerodha', 'zerodha.tradebook', 0.9)],
      probe,
    );
    expect(candidates.map((candidate) => candidate.kind)).toEqual(['zerodha.tradebook', 'dhan.x']);
  });

  it('ignores adapters that do not recognise the file', () => {
    expect(detectReport([fakeAdapter('dhan', 'dhan.x', null)], probe)).toEqual([]);
  });

  it('reports a recognised-but-rejected kind with its message', () => {
    const adapter: BrokerAdapter = {
      ...fakeAdapter('zerodha', 'zerodha.tradebook', null),
      detect: () => ({ kind: 'zerodha.pnl', confidence: 1 }),
    };
    expect(detectReport([adapter], probe)).toEqual([
      { broker: 'zerodha', kind: 'zerodha.pnl', confidence: 1, rejected: 'P&L reports are not needed in v1' },
    ]);
  });

  it('ignores confidences outside 0..1', () => {
    expect(detectReport([fakeAdapter('dhan', 'dhan.x', 1.5)], probe)).toEqual([]);
  });
});

describe('contract bounds (security review)', () => {
  it.each(['__proto__', 'Has Space', 'x'.repeat(65)])('rejects the flag key %j', (key) => {
    const flags = JSON.parse(`{"${key}": true}`) as Record<string, boolean>;
    expect(canonicalRowSchema.safeParse({ ...row, flags }).success).toBe(false);
  });

  it('caps string lengths', () => {
    expect(canonicalRowSchema.safeParse({ ...row, dedupKey: 'k'.repeat(257) }).success).toBe(false);
    expect(canonicalRowSchema.safeParse({ ...row, raw: { line: 1, text: 'x'.repeat(8193) } }).success).toBe(
      false,
    );
  });
});
