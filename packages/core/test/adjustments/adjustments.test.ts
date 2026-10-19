// S10a-1 (ADR-0013, PRD §5.5): adjustments applied inside reconstruction, redundant opening lots (E7), and
// opening-lot suggestions from broker statements.
import { describe, expect, it } from 'vitest';
import {
  grossPnlMicro,
  InvalidArgumentError,
  reconstructAccount,
  redundantOpeningLots,
  suggestOpeningLots,
  type Adjustment,
  type TradeFill,
} from '../../src/index.js';
import { fill, first, rupees } from '../fifo/helpers.js';

const ISIN = 'INE000000001';

function openingLot(overrides: Partial<Extract<Adjustment, { kind: 'opening_lot' }>> = {}): Adjustment {
  return {
    id: 'adj1',
    kind: 'opening_lot',
    accountId: 'acc',
    instrumentKey: ISIN,
    bucket: 'DELIVERY',
    quantity: 10n,
    totalCostMicro: 800_000_000n,
    beforeDateIst: '2025-09-12',
    ...overrides,
  };
}

const orphanSell = (): TradeFill =>
  fill({ side: 'SELL', qty: 10, price: 120, at: '2025-09-12 10:00', product: 'DELIVERY' });

describe('opening lots (E5 -> E6)', () => {
  it('E6: an opening lot "before 2025-09-12" completes the position; gross = proceeds - cost', () => {
    const { positions, allocations } = reconstructAccount([orphanSell()], [openingLot()]);
    const position = first(positions);
    expect([position.state, position.incomplete, rupees(grossPnlMicro(position))]).toEqual([
      'CLOSED',
      false,
      '400',
    ]);
    const lot = allocations.find((allocation) => allocation.adjustmentId === 'adj1');
    expect(lot).toMatchObject({
      side: 'BUY',
      bucket: 'DELIVERY',
      quantity: 10n,
      valueMicro: 800_000_000n,
      inferred: false,
    });
    // One second before the IST day starts: before every fill of that day.
    expect(lot?.executedAtUtc).toBe('2025-09-11T18:29:59Z');
    expect(lot?.tradeDateIst).toBe('2025-09-11');
  });

  it('places an opening lot with an entry date at the start of that IST day', () => {
    const { allocations } = reconstructAccount(
      [orphanSell()],
      [openingLot({ beforeDateIst: undefined, entryDateIst: '2025-01-15' })],
    );
    expect(allocations.find((allocation) => allocation.adjustmentId === 'adj1')).toMatchObject({
      executedAtUtc: '2025-01-14T18:30:00Z',
      tradeDateIst: '2025-01-15',
    });
  });

  it('is never netted with same-day sells (it is a holding, not a trade)', () => {
    const sameDay = fill({ side: 'SELL', qty: 10, price: 120, at: '2025-01-15 10:00' });
    const { allocations } = reconstructAccount(
      [sameDay],
      [openingLot({ beforeDateIst: undefined, entryDateIst: '2025-01-15' })],
    );
    expect(allocations.map((allocation) => allocation.bucket)).toEqual(['DELIVERY', 'DELIVERY']);
  });

  it('revert = leave it out: the position is INCOMPLETE again', () => {
    expect(first(reconstructAccount([orphanSell()], []).positions).incomplete).toBe(true);
  });

  it('rejects malformed opening lots', () => {
    const bad: Partial<Extract<Adjustment, { kind: 'opening_lot' }>>[] = [
      // Stored adjustments are runtime data: the type forbids INTRADAY, the guard must too.
      { bucket: 'INTRADAY' as 'DELIVERY' },
      { quantity: 0n },
      { totalCostMicro: -1n },
      { entryDateIst: '2025-01-01' },
      { beforeDateIst: undefined },
      { beforeDateIst: '2025-02-30' },
    ];
    for (const overrides of bad) {
      expect(() => reconstructAccount([orphanSell()], [openingLot(overrides)])).toThrow(InvalidArgumentError);
    }
  });

  it('only applies to its own account', () => {
    const { positions } = reconstructAccount([orphanSell()], [openingLot({ accountId: 'other' })]);
    expect(positions.find((position) => position.accountId === 'acc')?.incomplete).toBe(true);
  });
});

describe('exclude and product_override', () => {
  it('marks only the anchored position as excluded', () => {
    const fills = [
      fill({ side: 'BUY', qty: 5, price: 100, at: '2025-01-01 10:00', product: 'DELIVERY', instrument: 'A' }),
      fill({ side: 'BUY', qty: 5, price: 100, at: '2025-01-01 10:00', product: 'DELIVERY', instrument: 'B' }),
    ];
    const anchor = `${fills[0]?.dedupKey ?? ''}#DELIVERY`;
    const { positions } = reconstructAccount(fills, [
      { id: 'x', kind: 'exclude', accountId: 'acc', anchorKey: anchor },
    ]);
    expect(positions.map((position) => [position.instrumentKey, position.excluded])).toEqual([
      ['A', true],
      ['B', false],
    ]);
  });

  it('applies a product override adjustment', () => {
    const fills = [
      fill({ side: 'BUY', qty: 10, price: 100, at: '2025-01-02 10:00' }),
      fill({ side: 'SELL', qty: 10, price: 101, at: '2025-01-02 11:00' }),
    ];
    const override: Adjustment = {
      id: 'o',
      kind: 'product_override',
      accountId: 'acc',
      instrumentKey: ISIN,
      tradeDateIst: '2025-01-02',
      bucket: 'MTF',
    };
    expect(reconstructAccount(fills, [override]).positions.map((position) => position.bucket)).toEqual([
      'MTF',
    ]);
  });
});

describe('redundantOpeningLots (E7)', () => {
  it('a needed opening lot is not redundant', () => {
    expect(redundantOpeningLots([orphanSell()], [openingLot()])).toEqual([]);
  });

  it('becomes redundant once an older import brings the real buy', () => {
    const realBuy = fill({ side: 'BUY', qty: 10, price: 75, at: '2025-08-01 10:00', product: 'DELIVERY' });
    expect(redundantOpeningLots([orphanSell(), realBuy], [openingLot()])).toEqual(['adj1']);
  });

  it('is partly redundant when real fills cover part of it', () => {
    const realBuy = fill({ side: 'BUY', qty: 4, price: 75, at: '2025-08-01 10:00', product: 'DELIVERY' });
    expect(redundantOpeningLots([orphanSell(), realBuy], [openingLot()])).toEqual(['adj1']);
  });
});

describe('suggestOpeningLots', () => {
  const orphans = [
    {
      anchorKey: 'k1#DELIVERY',
      instrumentKey: 'INE377Y01014',
      bucket: 'DELIVERY' as const,
      quantity: 200n,
      dateIst: '2024-09-18',
    },
  ];
  const lot = {
    statementKey: 'tax|short_term|INE377Y01014|2024-09-17',
    isin: 'INE377Y01014',
    quantity: 200n,
    buyDateIst: '2024-09-17',
    sellDateIst: '2024-09-18' as string | null,
    buyValueMicro: 35_200_000_000n,
  };

  it('suggests the statement lot with the same ISIN and quantity, bought on or before the orphan sell', () => {
    expect(suggestOpeningLots(orphans, [lot])).toEqual([
      {
        anchorKey: 'k1#DELIVERY',
        instrumentKey: 'INE377Y01014',
        bucket: 'DELIVERY',
        quantity: 200n,
        totalCostMicro: 35_200_000_000n,
        entryDateIst: '2024-09-17',
        statementKey: lot.statementKey,
      },
    ]);
  });

  it('prefers a lot sold on the orphan day, and ignores later buys, other ISINs and other quantities', () => {
    const earlier = { ...lot, statementKey: 'older', buyDateIst: '2024-06-01', sellDateIst: '2024-06-02' };
    const later = { ...lot, statementKey: 'later', buyDateIst: '2024-09-19' };
    const otherIsin = { ...lot, statementKey: 'isin', isin: 'INE000000002' };
    const otherQty = { ...lot, statementKey: 'qty', quantity: 100n };
    expect(
      suggestOpeningLots(orphans, [earlier, later, otherIsin, otherQty, lot]).map(
        (entry) => entry.statementKey,
      ),
    ).toEqual([lot.statementKey]);
    // Sold before the orphan sell: it can't be the missing entry.
    expect(suggestOpeningLots(orphans, [earlier])).toEqual([]);
    expect(suggestOpeningLots(orphans, [later, otherIsin, otherQty])).toEqual([]);
  });

  it('never suggests a lot for an INTRADAY orphan', () => {
    expect(suggestOpeningLots([{ ...first(orphans), bucket: 'INTRADAY' }], [lot])).toEqual([]);
  });
});

describe('review follow-ups', () => {
  it('never flags a lot that is still held, or only partly sold, when no real buy precedes it', () => {
    const held = openingLot({ beforeDateIst: undefined, entryDateIst: '2025-01-15' });
    expect(redundantOpeningLots([], [held])).toEqual([]);
    const partSell = fill({ side: 'SELL', qty: 6, price: 120, at: '2025-03-01 10:00', product: 'DELIVERY' });
    expect(redundantOpeningLots([partSell], [held])).toEqual([]);
  });

  it('ignores real buys in other buckets or accounts', () => {
    const otherBucket = fill({ side: 'BUY', qty: 10, price: 75, at: '2025-08-01 10:00', product: 'MTF' });
    const otherAccount = fill({
      side: 'BUY',
      qty: 10,
      price: 75,
      at: '2025-08-01 10:00',
      product: 'DELIVERY',
      account: 'other',
    });
    expect(redundantOpeningLots([orphanSell(), otherBucket, otherAccount], [openingLot()])).toEqual([]);
  });

  it('rejects duplicate adjustment ids, unknown kinds and malformed overrides', () => {
    expect(() => reconstructAccount([], [openingLot(), openingLot()])).toThrow(InvalidArgumentError);
    const unknown = { id: 'u', kind: 'mystery', accountId: 'acc' } as unknown as Adjustment;
    expect(() => reconstructAccount([], [unknown])).toThrow(InvalidArgumentError);
    const badDate: Adjustment = {
      id: 'o',
      kind: 'product_override',
      accountId: 'acc',
      instrumentKey: ISIN,
      tradeDateIst: '2025-13-01',
      bucket: 'MTF',
    };
    expect(() => reconstructAccount([], [badDate])).toThrow(InvalidArgumentError);
    const badBucket = { ...badDate, tradeDateIst: '2025-01-02', bucket: 'FOO' } as unknown as Adjustment;
    expect(() => reconstructAccount([], [badBucket])).toThrow(InvalidArgumentError);
  });

  it('matches the sell against the lot (the lot sorts first) and anchors the position on the lot', () => {
    const { positions } = reconstructAccount([orphanSell()], [openingLot()]);
    const position = first(positions);
    expect([position.orphanQty, position.lots.length, position.anchorKey]).toEqual([
      0n,
      1,
      'adj:adj1#DELIVERY',
    ]);
  });
});

describe('suggestion review follow-ups', () => {
  const orphan = {
    anchorKey: 'a#DELIVERY',
    instrumentKey: 'INE377Y01014',
    bucket: 'DELIVERY' as const,
    quantity: 200n,
    dateIst: '2024-09-18',
  };
  const lot = {
    statementKey: 'L1',
    isin: 'INE377Y01014',
    quantity: 200n,
    buyDateIst: '2024-09-17',
    sellDateIst: '2024-09-18' as string | null,
    buyValueMicro: 1n,
  };

  it('never suggests a lot that was already sold before the orphan sell', () => {
    expect(suggestOpeningLots([orphan], [{ ...lot, sellDateIst: '2024-06-02' }])).toEqual([]);
    expect(suggestOpeningLots([orphan], [{ ...lot, sellDateIst: null }])).toHaveLength(1);
  });

  it('never gives the same statement lot to two orphans (earliest orphan first)', () => {
    const later = { ...orphan, anchorKey: 'b#DELIVERY', dateIst: '2024-10-01' };
    const open = { ...lot, sellDateIst: null };
    expect(suggestOpeningLots([later, orphan], [open]).map((entry) => entry.anchorKey)).toEqual([
      'a#DELIVERY',
    ]);
  });
});
