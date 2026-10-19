// PRD §7 worked examples (E1-E5, E11 without the opening lot, E12) and the netting rule (ADR-0012), end to end
// through allocateBuckets -> matchFifo -> buildPositions.
import { describe, expect, it } from 'vitest';
import {
  allocateBuckets,
  buildPositions,
  grossPnlMicro,
  matchFifo,
  type Position,
  type ProductOverride,
  type TradeFill,
} from '../../src/index.js';
import { fill, rupees } from './helpers.js';

function reconstruct(fills: readonly TradeFill[], overrides: readonly ProductOverride[] = []): Position[] {
  const allocations = allocateBuckets(fills, overrides);
  return buildPositions(allocations, matchFifo(allocations));
}

function summary(position: Position): Record<string, unknown> {
  return {
    bucket: position.bucket,
    state: position.state,
    incomplete: position.incomplete,
    orphanQty: position.orphanQty,
    lots: position.lots.map(
      (lot) =>
        `${String(lot.quantity)} ${rupees(lot.entryValueMicro)}->${lot.exitValueMicro === null ? 'open' : rupees(lot.exitValueMicro)}`,
    ),
    gross: rupees(grossPnlMicro(position)),
  };
}

describe('PRD §7.5 worked examples', () => {
  it('E1: FIFO across two buys and two sells', () => {
    const positions = reconstruct([
      fill({ side: 'BUY', qty: 10, price: 100, at: '2025-01-01 10:00', product: 'DELIVERY' }),
      fill({ side: 'BUY', qty: 10, price: 110, at: '2025-01-02 10:00', product: 'DELIVERY' }),
      fill({ side: 'SELL', qty: 15, price: 120, at: '2025-01-03 10:00', product: 'DELIVERY' }),
      fill({ side: 'SELL', qty: 5, price: 90, at: '2025-01-04 10:00', product: 'DELIVERY' }),
    ]);
    expect(positions.map(summary)).toEqual([
      {
        bucket: 'DELIVERY',
        state: 'CLOSED',
        incomplete: false,
        orphanQty: 0n,
        lots: ['10 1000->1200', '5 550->600', '5 550->450'],
        gross: '150',
      },
    ]);
  });

  it('E2: a Zerodha same-day round trip is INTRADAY and inferred', () => {
    const allocations = allocateBuckets(
      [
        fill({ side: 'BUY', qty: 20, price: 100, at: '2025-09-12 10:00' }),
        fill({ side: 'SELL', qty: 20, price: 101, at: '2025-09-12 14:00' }),
      ],
      [],
    );
    expect(allocations.every((allocation) => allocation.bucket === 'INTRADAY' && allocation.inferred)).toBe(true);
    expect(buildPositions(allocations, matchFifo(allocations)).map(summary)).toEqual([
      { bucket: 'INTRADAY', state: 'CLOSED', incomplete: false, orphanQty: 0n, lots: ['20 2000->2020'], gross: '20' },
    ]);
  });

  it('E3: same-day buy and sell against an existing holding is intraday; the held lot is untouched', () => {
    const positions = reconstruct([
      fill({ side: 'BUY', qty: 10, price: 100, at: '2025-01-01 10:00' }),
      fill({ side: 'BUY', qty: 5, price: 110, at: '2025-01-02 10:00' }),
      fill({ side: 'SELL', qty: 5, price: 112, at: '2025-01-02 11:00' }),
    ]);
    expect(positions.map(summary)).toEqual([
      { bucket: 'DELIVERY', state: 'OPEN', incomplete: false, orphanQty: 0n, lots: ['10 1000->open'], gross: '0' },
      { bucket: 'INTRADAY', state: 'CLOSED', incomplete: false, orphanQty: 0n, lots: ['5 550->560'], gross: '10' },
    ]);
  });

  it('E4: an NSE buy and a BSE sell of the same ISIN form one position (exchange is not part of the key)', () => {
    const positions = reconstruct([
      fill({ side: 'BUY', qty: 10, price: 100, at: '2025-01-01 10:00', product: 'DELIVERY' }),
      fill({ side: 'SELL', qty: 10, price: 105, at: '2025-01-05 10:00', product: 'DELIVERY' }),
    ]);
    expect(positions).toHaveLength(1);
    expect(summary(positions[0] as Position)).toMatchObject({ gross: '50', state: 'CLOSED' });
  });

  it('E5: a sell with no prior buy is an INCOMPLETE position with the orphan quantity', () => {
    const positions = reconstruct([fill({ side: 'SELL', qty: 10, price: 120, at: '2025-09-12 10:00' })]);
    expect(positions.map(summary)).toEqual([
      { bucket: 'DELIVERY', state: 'CLOSED', incomplete: true, orphanQty: 10n, lots: [], gross: '0' },
    ]);
  });

  it('E11: buys net against the earliest sells; the rest of the sells is an orphan', () => {
    const positions = reconstruct([
      fill({ side: 'BUY', qty: 100, price: 181, at: '2024-09-18 09:07:00', product: 'DELIVERY' }),
      fill({ side: 'SELL', qty: 100, price: '173.50', at: '2024-09-18 09:16:37', product: 'DELIVERY' }),
      fill({ side: 'SELL', qty: 200, price: '174.05', at: '2024-09-18 09:16:45', product: 'DELIVERY' }),
    ]);
    expect(positions.map(summary)).toEqual([
      { bucket: 'DELIVERY', state: 'CLOSED', incomplete: true, orphanQty: 200n, lots: [], gross: '0' },
      { bucket: 'INTRADAY', state: 'CLOSED', incomplete: false, orphanQty: 0n, lots: ['100 18100->17350'], gross: '-750' },
    ]);
  });

  it('E12: a same-day MTF round trip is INTRADAY (declared product kept on the fill, not inferred)', () => {
    const allocations = allocateBuckets(
      [
        fill({ side: 'BUY', qty: 2, price: '933.90', at: '2024-04-30 10:00', product: 'MTF' }),
        fill({ side: 'SELL', qty: 2, price: '953.30', at: '2024-04-30 14:00', product: 'MTF' }),
      ],
      [],
    );
    expect(allocations.map((allocation) => [allocation.bucket, allocation.inferred])).toEqual([
      ['INTRADAY', false],
      ['INTRADAY', false],
    ]);
    expect(summary(buildPositions(allocations, matchFifo(allocations))[0] as Position).gross).toBe('38.8');
  });
});

describe('same-day netting (ADR-0012)', () => {
  it('splits a fill at the intraday boundary, with values split exactly', () => {
    const allocations = allocateBuckets(
      [
        fill({ side: 'BUY', qty: 10, price: '100.1', at: '2025-01-02 10:00' }),
        fill({ side: 'SELL', qty: 4, price: 101, at: '2025-01-02 11:00' }),
      ],
      [],
    );
    const buys = allocations.filter((allocation) => allocation.side === 'BUY');
    expect(buys.map((allocation) => [allocation.bucket, allocation.quantity, allocation.valueMicro])).toEqual([
      ['INTRADAY', 4n, 400_400_000n],
      ['DELIVERY', 6n, 600_600_000n],
    ]);
  });

  it('takes the intraday quantity from the earliest sells, whatever the buy times', () => {
    const allocations = allocateBuckets(
      [
        fill({ side: 'SELL', qty: 3, price: 100, at: '2025-01-02 09:30' }),
        fill({ side: 'BUY', qty: 5, price: 100, at: '2025-01-02 10:00' }),
        fill({ side: 'SELL', qty: 3, price: 100, at: '2025-01-02 11:00' }),
      ],
      [],
    );
    const sells = allocations.filter((allocation) => allocation.side === 'SELL');
    expect(sells.map((allocation) => [allocation.executedAtUtc.slice(11, 16), allocation.bucket, allocation.quantity])).toEqual([
      ['04:00', 'INTRADAY', 3n],
      ['05:30', 'INTRADAY', 2n],
      ['05:30', 'DELIVERY', 1n],
    ]);
  });

  it('keeps the declared product for the remainder (MTF, DELIVERY), and an INTRADAY remainder becomes DELIVERY', () => {
    const allocations = allocateBuckets(
      [
        fill({ side: 'BUY', qty: 10, price: 100, at: '2025-01-02 10:00', product: 'MTF', instrument: 'A' }),
        fill({ side: 'SELL', qty: 4, price: 100, at: '2025-01-02 11:00', product: 'MTF', instrument: 'A' }),
        fill({ side: 'BUY', qty: 7, price: 100, at: '2025-01-02 10:00', product: 'INTRADAY', instrument: 'B' }),
      ],
      [],
    );
    expect(allocations.map((allocation) => `${allocation.instrumentKey} ${allocation.side} ${allocation.bucket} ${String(allocation.quantity)}`)).toEqual([
      'A BUY INTRADAY 4',
      'A BUY MTF 6',
      'B BUY DELIVERY 7',
      'A SELL INTRADAY 4',
    ]);
  });

  it('applies a product override to the whole (account, instrument, day), not inferred', () => {
    const fills = [
      fill({ side: 'BUY', qty: 10, price: 100, at: '2025-01-02 10:00' }),
      fill({ side: 'SELL', qty: 10, price: 101, at: '2025-01-02 11:00' }),
    ];
    const override: ProductOverride = { accountId: 'acc', instrumentKey: 'INE000000001', tradeDateIst: '2025-01-02', bucket: 'DELIVERY' };
    const allocations = allocateBuckets(fills, [override]);
    expect(allocations.map((allocation) => [allocation.bucket, allocation.inferred])).toEqual([
      ['DELIVERY', false],
      ['DELIVERY', false],
    ]);
  });
});

describe('intraday shorts', () => {
  it('pairs a sell before a buy on the same day as one intraday round trip, not an orphan', () => {
    const positions = reconstruct([
      fill({ side: 'SELL', qty: 10, price: 105, at: '2025-01-02 10:00' }),
      fill({ side: 'BUY', qty: 10, price: 100, at: '2025-01-02 11:00' }),
    ]);
    expect(positions.map(summary)).toEqual([
      { bucket: 'INTRADAY', state: 'CLOSED', incomplete: false, orphanQty: 0n, lots: ['10 1000->1050'], gross: '50' },
    ]);
  });

  it('makes one position per intraday round trip within a day', () => {
    const positions = reconstruct([
      fill({ side: 'BUY', qty: 5, price: 100, at: '2025-01-02 10:00' }),
      fill({ side: 'SELL', qty: 5, price: 101, at: '2025-01-02 10:30' }),
      fill({ side: 'BUY', qty: 5, price: 102, at: '2025-01-02 11:00' }),
      fill({ side: 'SELL', qty: 5, price: 103, at: '2025-01-02 11:30' }),
    ]);
    expect(positions.map(summary).map((entry) => entry.lots)).toEqual([['5 500->505'], ['5 510->515']]);
  });
});

describe('isolation (ADR-0011)', () => {
  it('never matches across accounts or buckets', () => {
    const positions = reconstruct([
      fill({ side: 'BUY', qty: 10, price: 100, at: '2025-01-01 10:00', account: 'A', product: 'DELIVERY' }),
      fill({ side: 'SELL', qty: 10, price: 110, at: '2025-01-03 10:00', account: 'B', product: 'DELIVERY' }),
      fill({ side: 'BUY', qty: 5, price: 100, at: '2025-01-01 10:00', account: 'A', product: 'MTF', instrument: 'X' }),
      fill({ side: 'SELL', qty: 5, price: 110, at: '2025-01-03 10:00', account: 'A', product: 'DELIVERY', instrument: 'X' }),
    ]);
    expect(positions.map((position) => `${position.accountId} ${position.instrumentKey} ${position.bucket} ${position.state} ${String(position.incomplete)}`)).toEqual([
      'A INE000000001 DELIVERY OPEN false',
      'A X DELIVERY CLOSED true',
      'A X MTF OPEN false',
      'B INE000000001 DELIVERY CLOSED true',
    ]);
  });

  it('starts a new position after the holding returns to zero, and groups consecutive orphan sells', () => {
    const positions = reconstruct([
      fill({ side: 'SELL', qty: 3, price: 100, at: '2025-01-01 10:00', product: 'DELIVERY' }),
      fill({ side: 'SELL', qty: 2, price: 100, at: '2025-01-01 10:05', product: 'DELIVERY' }),
      fill({ side: 'BUY', qty: 10, price: 100, at: '2025-01-03 10:00', product: 'DELIVERY' }),
      fill({ side: 'SELL', qty: 12, price: 110, at: '2025-01-05 10:00', product: 'DELIVERY' }),
      fill({ side: 'BUY', qty: 4, price: 100, at: '2025-01-07 10:00', product: 'DELIVERY' }),
    ]);
    expect(positions.map((position) => [position.state, position.incomplete, position.orphanQty, position.lots.length])).toEqual([
      ['CLOSED', true, 5n, 0],
      ['CLOSED', true, 2n, 1],
      ['OPEN', false, 0n, 1],
    ]);
    expect(new Set(positions.map((position) => position.id)).size).toBe(3);
  });
});

describe('position identity', () => {
  it('derives ids and anchors from the opening fill, so a recompute gives the same ids', () => {
    const fills = [
      fill({ side: 'BUY', qty: 10, price: 100, at: '2025-01-01 10:00', product: 'DELIVERY' }),
      fill({ side: 'SELL', qty: 10, price: 105, at: '2025-01-05 10:00', product: 'DELIVERY' }),
    ];
    const [first] = reconstruct(fills);
    const [again] = reconstruct([...fills].reverse());
    expect(first?.id).toBe(again?.id);
    expect(first?.anchorKey).toBe(`${fills[0]?.dedupKey ?? ''}#DELIVERY`);
    expect(first?.openedAtUtc).toBe(fills[0]?.executedAtUtc);
    expect(first?.closedAtUtc).toBe(fills[1]?.executedAtUtc);
  });

});
