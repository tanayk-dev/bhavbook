// Invariants (PRD §3.2): no negative holdings, quantities and values conserved to the micro-rupee, no matching
// across accounts or buckets, and the result does not depend on input order.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allocateBuckets,
  buildPositions,
  groupFillsIntoOrders,
  matchFifo,
  type TradeFill,
} from '../../src/index.js';
import { fill } from './helpers.js';

const fillArbitrary = fc.record({
  side: fc.constantFrom('BUY' as const, 'SELL' as const),
  qty: fc.integer({ min: 1, max: 50 }),
  price: fc.integer({ min: 1, max: 999 }),
  day: fc.integer({ min: 1, max: 4 }),
  minute: fc.integer({ min: 0, max: 59 }),
  account: fc.constantFrom('A', 'B'),
  instrument: fc.constantFrom('X', 'Y'),
  product: fc.constantFrom(null, 'DELIVERY' as const, 'MTF' as const, 'INTRADAY' as const),
});

const fillsArbitrary = fc.array(fillArbitrary, { minLength: 1, maxLength: 30 }).map((specs) =>
  specs.map((spec) =>
    fill({
      side: spec.side,
      qty: spec.qty,
      price: spec.price,
      at: `2025-01-0${String(spec.day)} 10:${String(spec.minute).padStart(2, '0')}`,
      account: spec.account,
      instrument: spec.instrument,
      product: spec.product,
    }),
  ),
);

describe('reconstruction properties', () => {
  it('conserves every allocation quantity and value, never matches across keys, never goes negative', () => {
    fc.assert(
      fc.property(fillsArbitrary, (fills) => {
        const allocations = allocateBuckets(fills, []);
        // Allocation conserves each fill exactly.
        for (const source of fills) {
          const parts = allocations.filter((allocation) => allocation.fillId === source.id);
          expect(parts.reduce((sum, part) => sum + part.quantity, 0n)).toBe(source.quantity);
          expect(parts.reduce((sum, part) => sum + part.valueMicro, 0n)).toBe(source.valueMicro);
        }
        const { lots, orphans } = matchFifo(allocations);
        const keyOf = (value: { accountId: string; instrumentKey: string; bucket: string }): string =>
          `${value.accountId}|${value.instrumentKey}|${value.bucket}`;
        const byKey = new Map(allocations.map((allocation) => [allocation.key, allocation]));
        for (const lot of lots) {
          const entry = byKey.get(lot.entry);
          expect(entry?.side).toBe('BUY');
          expect(keyOf(entry ?? lot)).toBe(keyOf(lot));
          if (lot.exit !== null) {
            const exit = byKey.get(lot.exit);
            expect(exit?.side).toBe('SELL');
            expect(keyOf(exit ?? lot)).toBe(keyOf(lot));
            // Delivery and MTF never go short; intraday pairs within the day (a sell may come first).
            if (lot.bucket !== 'INTRADAY') {
              expect((exit?.executedAtUtc ?? '') >= (entry?.executedAtUtc ?? '')).toBe(true);
            }
          }
        }
        // Every allocation's quantity and value are fully used: by lots (entry or exit) or as an orphan.
        for (const allocation of allocations) {
          const asEntry = lots.filter((lot) => lot.entry === allocation.key);
          const asExit = lots.filter((lot) => lot.exit === allocation.key);
          const asOrphan = orphans.filter((orphan) => orphan.allocation === allocation.key);
          if (allocation.side === 'BUY') {
            expect(asEntry.reduce((sum, lot) => sum + lot.quantity, 0n)).toBe(allocation.quantity);
            expect(asEntry.reduce((sum, lot) => sum + lot.entryValueMicro, 0n)).toBe(allocation.valueMicro);
          } else {
            const quantity =
              asExit.reduce((sum, lot) => sum + lot.quantity, 0n) + asOrphan.reduce((sum, orphan) => sum + orphan.quantity, 0n);
            const value =
              asExit.reduce((sum, lot) => sum + (lot.exitValueMicro ?? 0n), 0n) +
              asOrphan.reduce((sum, orphan) => sum + orphan.valueMicro, 0n);
            expect(quantity).toBe(allocation.quantity);
            expect(value).toBe(allocation.valueMicro);
          }
        }
        // Holdings never go negative at any point.
        const positions = buildPositions(allocations, { lots, orphans });
        for (const position of positions) {
          const open = position.lots.filter((lot) => lot.exit === null).reduce((sum, lot) => sum + lot.quantity, 0n);
          expect(open >= 0n).toBe(true);
          expect(position.state === 'OPEN').toBe(open > 0n);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('gives the same result for any input order', () => {
    const shuffledPair = fillsArbitrary.chain((fills) =>
      fc.tuple(fc.constant(fills), fc.shuffledSubarray(fills, { minLength: fills.length, maxLength: fills.length })),
    );
    fc.assert(
      fc.property(shuffledPair, ([fills, shuffled]) => {
        const run = (input: readonly TradeFill[]): unknown => {
          const allocations = allocateBuckets(input, []);
          return buildPositions(allocations, matchFifo(allocations));
        };
        expect(run(shuffled)).toEqual(run(fills));
      }),
      { numRuns: 200 },
    );
  });
});

describe('groupFillsIntoOrders', () => {
  it('groups fill-granularity rows by order id; order rows pass through', () => {
    const fills = [
      fill({ side: 'BUY', qty: 3, price: 100, at: '2025-01-02 10:00', order: 'O1' }),
      fill({ side: 'BUY', qty: 2, price: 101, at: '2025-01-02 10:01', order: 'O1' }),
      fill({ side: 'SELL', qty: 5, price: 102, at: '2025-01-02 11:00', order: 'O2' }),
      fill({ side: 'BUY', qty: 7, price: 99, at: '2025-01-02 12:00', granularity: 'order' }),
      fill({ side: 'BUY', qty: 1, price: 99, at: '2025-01-02 12:30' }),
    ];
    const orders = groupFillsIntoOrders(fills);
    expect(orders.map((order) => [order.side, order.quantity, order.valueMicro, order.fills.length])).toEqual([
      ['BUY', 5n, 502_000_000n, 2],
      ['SELL', 5n, 510_000_000n, 1],
      ['BUY', 7n, 693_000_000n, 1],
      ['BUY', 1n, 99_000_000n, 1],
    ]);
    expect(new Set(orders.map((order) => order.key)).size).toBe(4);
  });
});
