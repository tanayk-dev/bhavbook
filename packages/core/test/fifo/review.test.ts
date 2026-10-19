// S9-1 review follow-ups: a real FIFO reference model and holdings replay, input validation, override rules, the
// cases the first tests missed, and scale.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allocateBuckets,
  buildPositions,
  grossPnlMicro,
  InvalidArgumentError,
  matchFifo,
  type FillAllocation,
  type ProductOverride,
  type TradeFill,
} from '../../src/index.js';
import { fill, first, rupees } from './helpers.js';

function reconstruct(fills: readonly TradeFill[], overrides: readonly ProductOverride[] = []) {
  const allocations = allocateBuckets(fills, overrides);
  const matched = matchFifo(allocations);
  return { allocations, matched, positions: buildPositions(allocations, matched) };
}

const fillsArbitrary = fc
  .array(
    fc.record({
      side: fc.constantFrom('BUY' as const, 'SELL' as const),
      qty: fc.integer({ min: 1, max: 40 }),
      price: fc.integer({ min: 1, max: 999 }),
      day: fc.integer({ min: 1, max: 4 }),
      minute: fc.integer({ min: 0, max: 5 }),
      account: fc.constantFrom('A', 'B'),
      product: fc.constantFrom(null, 'DELIVERY' as const, 'MTF' as const),
    }),
    { minLength: 1, maxLength: 40 },
  )
  .map((specs) =>
    specs.map((spec) =>
      fill({
        side: spec.side,
        qty: spec.qty,
        price: spec.price,
        at: `2025-01-0${String(spec.day)} 10:0${String(spec.minute)}`,
        account: spec.account,
        product: spec.product,
      }),
    ),
  );

/** Independent FIFO for held buckets: per sell, the (buy, qty) pieces it consumes, oldest buy first. */
function referenceFifo(allocations: readonly FillAllocation[]): Map<string, string[]> {
  const bySell = new Map<string, string[]>();
  const queues = new Map<string, { key: string; left: bigint }[]>();
  const ordered = [...allocations].sort((a, b) =>
    a.executedAtUtc === b.executedAtUtc
      ? a.dedupKey === b.dedupKey
        ? a.accountId < b.accountId
          ? -1
          : 1
        : a.dedupKey < b.dedupKey
          ? -1
          : 1
      : a.executedAtUtc < b.executedAtUtc
        ? -1
        : 1,
  );
  for (const allocation of ordered) {
    if (allocation.bucket === 'INTRADAY') continue;
    const group = `${allocation.accountId}|${allocation.instrumentKey}|${allocation.bucket}`;
    const queue = queues.get(group) ?? [];
    queues.set(group, queue);
    if (allocation.side === 'BUY') {
      queue.push({ key: allocation.key, left: allocation.quantity });
      continue;
    }
    const pieces: string[] = [];
    let need = allocation.quantity;
    while (need > 0n && queue.length > 0) {
      const head = queue[0];
      if (head === undefined) break;
      const take = head.left < need ? head.left : need;
      pieces.push(`${head.key}:${String(take)}`);
      head.left -= take;
      need -= take;
      if (head.left === 0n) queue.shift();
    }
    if (need > 0n) pieces.push(`orphan:${String(need)}`);
    bySell.set(allocation.key, pieces);
  }
  return bySell;
}

describe('FIFO against an independent reference', () => {
  it('consumes the oldest open buys first and orphans only the shortfall', () => {
    fc.assert(
      fc.property(fillsArbitrary, (fills) => {
        const { allocations, matched } = reconstruct(fills);
        const expected = referenceFifo(allocations);
        for (const [sell, pieces] of expected) {
          const actual = [
            ...matched.lots
              .filter((lot) => lot.exit === sell)
              .map((lot) => `${lot.entry}:${String(lot.quantity)}`),
            ...matched.orphans
              .filter((orphan) => orphan.allocation === sell)
              .map((orphan) => `orphan:${String(orphan.quantity)}`),
          ];
          expect(actual).toEqual(pieces);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('never lets a held bucket go below zero, replayed step by step', () => {
    fc.assert(
      fc.property(fillsArbitrary, (fills) => {
        const { allocations, matched } = reconstruct(fills);
        const orphaned = new Map<string, bigint>();
        for (const orphan of matched.orphans)
          orphaned.set(orphan.allocation, (orphaned.get(orphan.allocation) ?? 0n) + orphan.quantity);
        const held = new Map<string, bigint>();
        for (const allocation of allocations) {
          if (allocation.bucket === 'INTRADAY') continue;
          const group = `${allocation.accountId}|${allocation.instrumentKey}|${allocation.bucket}`;
          const before = held.get(group) ?? 0n;
          const after =
            allocation.side === 'BUY'
              ? before + allocation.quantity
              : before - (allocation.quantity - (orphaned.get(allocation.key) ?? 0n));
          expect(after >= 0n).toBe(true);
          // An orphan only appears when the holding could not cover the sell.
          if ((orphaned.get(allocation.key) ?? 0n) > 0n) expect(after).toBe(0n);
          held.set(group, after);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('keeps accounts apart even when their dedup keys collide', () => {
    const a = fill({
      side: 'BUY',
      qty: 5,
      price: 100,
      at: '2025-01-01 10:00',
      account: 'A',
      product: 'DELIVERY',
    });
    const b = {
      ...fill({
        side: 'SELL',
        qty: 5,
        price: 100,
        at: '2025-01-01 10:00',
        account: 'B',
        product: 'DELIVERY',
      }),
      dedupKey: a.dedupKey,
    };
    const { positions } = reconstruct([b, a]);
    expect(positions.map((position) => [position.accountId, position.state, position.incomplete])).toEqual([
      ['A', 'OPEN', false],
      ['B', 'CLOSED', true],
    ]);
  });
});

describe('cases the first tests missed', () => {
  it('a sell partly matched and partly orphaned', () => {
    const { positions } = reconstruct([
      fill({ side: 'BUY', qty: 5, price: 100, at: '2025-01-01 10:00', product: 'DELIVERY' }),
      fill({ side: 'SELL', qty: 8, price: 110, at: '2025-01-03 10:00', product: 'DELIVERY' }),
    ]);
    const position = first(positions);
    expect([position.state, position.incomplete, position.orphanQty, position.lots.length]).toEqual([
      'CLOSED',
      true,
      3n,
      1,
    ]);
    expect(position.lots[0]?.exitValueMicro).toBe(550_000_000n);
    expect(position.orphans[0]?.valueMicro).toBe(330_000_000n);
  });

  it('splits an indivisible value across three lots exactly', () => {
    const buy = {
      ...fill({ side: 'BUY', qty: 3, price: 0, at: '2025-01-01 10:00', product: 'DELIVERY' }),
      valueMicro: 100n,
    };
    const sells = [1, 2, 3].map((day) =>
      fill({ side: 'SELL', qty: 1, price: 1, at: `2025-01-0${String(day + 1)} 10:00`, product: 'DELIVERY' }),
    );
    const lots = first(reconstruct([buy, ...sells]).positions).lots;
    expect(lots.map((lot) => lot.entryValueMicro)).toEqual([34n, 33n, 33n]);
  });

  it('an MTF holding is its own bucket and position', () => {
    const { positions } = reconstruct([
      fill({ side: 'BUY', qty: 10, price: 100, at: '2025-01-01 10:00', product: 'MTF' }),
      fill({ side: 'SELL', qty: 10, price: 120, at: '2025-01-09 10:00', product: 'MTF' }),
    ]);
    expect(
      positions.map((position) => [position.bucket, position.state, rupees(grossPnlMicro(position))]),
    ).toEqual([['MTF', 'CLOSED', '200']]);
  });

  it('an override to DELIVERY keeps a netted day out of intraday', () => {
    const fills = [
      fill({ side: 'BUY', qty: 10, price: 100, at: '2025-01-02 10:00' }),
      fill({ side: 'SELL', qty: 10, price: 101, at: '2025-01-02 11:00' }),
    ];
    const { positions } = reconstruct(fills, [
      { accountId: 'acc', instrumentKey: 'INE000000001', tradeDateIst: '2025-01-02', bucket: 'DELIVERY' },
    ]);
    expect(
      positions.map((position) => [position.bucket, position.state, position.hasInferredProduct]),
    ).toEqual([['DELIVERY', 'CLOSED', false]]);
  });

  it('an INTRADAY override on an unbalanced day only re-buckets what can be intraday', () => {
    const fills = [
      fill({ side: 'BUY', qty: 10, price: 100, at: '2025-01-02 10:00', product: 'DELIVERY' }),
      fill({ side: 'SELL', qty: 4, price: 101, at: '2025-01-02 11:00', product: 'DELIVERY' }),
    ];
    const { allocations } = reconstruct(fills, [
      { accountId: 'acc', instrumentKey: 'INE000000001', tradeDateIst: '2025-01-02', bucket: 'INTRADAY' },
    ]);
    expect(
      allocations.map(
        (allocation) =>
          `${allocation.side} ${allocation.bucket} ${String(allocation.quantity)} ${String(allocation.inferred)}`,
      ),
    ).toEqual(['BUY INTRADAY 4 false', 'BUY DELIVERY 6 false', 'SELL INTRADAY 4 false']);
  });
});

describe('input validation', () => {
  it('rejects zero quantities, negative values and malformed timestamps', () => {
    const good = fill({ side: 'BUY', qty: 1, price: 1, at: '2025-01-01 10:00' });
    expect(() => allocateBuckets([{ ...good, quantity: 0n }], [])).toThrow(InvalidArgumentError);
    expect(() => allocateBuckets([{ ...good, valueMicro: -1n }], [])).toThrow(InvalidArgumentError);
    expect(() => allocateBuckets([{ ...good, executedAtUtc: '2025-01-01T04:30:00.5Z' }], [])).toThrow(
      InvalidArgumentError,
    );
  });

  it('rejects two overrides for the same day (the winner would depend on input order)', () => {
    const override: ProductOverride = {
      accountId: 'acc',
      instrumentKey: 'X',
      tradeDateIst: '2025-01-02',
      bucket: 'DELIVERY',
    };
    expect(() => allocateBuckets([], [override, { ...override, bucket: 'MTF' }])).toThrow(
      InvalidArgumentError,
    );
  });
});

describe('scale', () => {
  it('reconstructs 20,000 fills', () => {
    const fills = Array.from({ length: 20_000 }, (_unused, index) =>
      fill({
        side: index % 3 === 2 ? 'SELL' : 'BUY',
        qty: 1 + (index % 7),
        price: 100 + (index % 50),
        at: `2025-${String(1 + (index % 12)).padStart(2, '0')}-${String(1 + (index % 28)).padStart(2, '0')} 10:${String(index % 60).padStart(2, '0')}`,
        instrument: `I${String(index % 40)}`,
        product: index % 5 === 0 ? 'MTF' : null,
      }),
    );
    const started = performance.now();
    const { positions } = reconstruct(fills);
    expect(positions.length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
