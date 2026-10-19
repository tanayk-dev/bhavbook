// S10b-1 review follow-ups: stored-data validation, cost conservation, exclusions, redundancy, preview edits.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  InvalidArgumentError,
  previewCorporateAction,
  reconstructAccount,
  redundantOpeningLots,
  type Adjustment,
  type CorporateAction,
  type Position,
  type TradeFill,
} from '../../src/index.js';
import { fill, first, RUPEE, rupees } from '../fifo/helpers.js';

const OLD = 'INE155A01022';
const NEW = 'INE1TAE01010';

/** Overrides may break the types on purpose (stored data). */
function action(overrides: Record<string, unknown>): CorporateAction {
  const stored: unknown = {
    id: 'ca1',
    type: 'SPLIT',
    isin: OLD,
    newIsin: null,
    exDateIst: '2025-03-01',
    allotmentDateIst: null,
    ratioNum: 5n,
    ratioDen: 1n,
    costSplitBp: null,
    ...overrides,
  };
  return stored as CorporateAction;
}

const buy = (qty: number, price: number, at: string, product: 'DELIVERY' | 'MTF' = 'DELIVERY'): TradeFill =>
  fill({ side: 'BUY', qty, price, at, product, instrument: OLD });
const sell = (qty: number, price: number, at: string, instrument = OLD): TradeFill =>
  fill({ side: 'SELL', qty, price, at, product: 'DELIVERY', instrument });

function lotsOf(position: Position): string[] {
  return position.lots.map(
    (lot) =>
      `${String(lot.quantity)} ${rupees(lot.entryValueMicro)} ${lot.entryDateIst}->${lot.exitValueMicro === null ? 'open' : rupees(lot.exitValueMicro)}`,
  );
}

describe('stored-data validation', () => {
  const demerger = { type: 'DEMERGER', newIsin: NEW, ratioNum: 1n, ratioDen: 1n, costSplitBp: 3115n };
  it.each([
    ['empty id', { id: '' }],
    ['id with a key separator', { id: 'a~b' }],
    ['non-string id', { id: 5 }],
    ['empty ISIN', { isin: '' }],
    ['non-string ISIN', { isin: 5 }],
    ['non-string ex-date', { exDateIst: 20250301 }],
    ['negative ratio', { ratioNum: -1n }],
    ['conversion with a missing new ISIN', { type: 'CONVERSION', newIsin: undefined }],
    ['conversion to the same ISIN', { type: 'CONVERSION', newIsin: OLD }],
    ['demerger into the same ISIN', { ...demerger, newIsin: OLD }],
    ['a new ISIN on a split', { newIsin: NEW }],
    ['a split onto its own ISIN', { newIsin: OLD }],
    ['a missing new ISIN on a split', { newIsin: undefined }],
    ['a missing cost split on a split', { costSplitBp: undefined }],
    ['a cost split on a split', { costSplitBp: 0n }],
    ['negative cost split', { ...demerger, costSplitBp: -1n }],
    ['an allotment date on a split', { allotmentDateIst: '2025-03-04' }],
    ['non-string allotment date', { type: 'BONUS', allotmentDateIst: 5 }],
  ])('rejects %s', (_, overrides) => {
    expect(() => reconstructAccount([], [], [action(overrides)])).toThrow(InvalidArgumentError);
  });

  it.each([0n, 10_000n])('accepts a demerger cost split of %s bp', (costSplitBp) => {
    expect(() => reconstructAccount([], [], [action({ ...demerger, costSplitBp })])).not.toThrow();
  });
});

describe('cost conservation', () => {
  it('a demerger child too small for a whole share hands its cost back to the parent', () => {
    const demerger = action({
      type: 'DEMERGER',
      newIsin: NEW,
      ratioNum: 1n,
      ratioDen: 10n,
      costSplitBp: 3000n,
    });
    const { positions, fractions } = reconstructAccount([buy(5, 100, '2025-01-01 10:00')], [], [demerger]);
    expect(positions.map((position) => [position.instrumentKey, lotsOf(position)])).toEqual([
      [OLD, ['5 500 2025-01-01->open']],
    ]);
    expect(fractions).toEqual([
      {
        actionId: 'ca1',
        accountId: 'acc',
        instrumentKey: NEW,
        bucket: 'DELIVERY',
        numerator: 5n,
        denominator: 10n,
        costRemovedMicro: 0n,
      },
    ]);
  });

  it('a conversion reports its fraction against the new ISIN', () => {
    const conversion = action({ type: 'CONVERSION', newIsin: NEW, ratioNum: 1n, ratioDen: 2n });
    const { fractions } = reconstructAccount([buy(3, 100, '2025-01-01 10:00')], [], [conversion]);
    expect(
      fractions.map((fraction) => [fraction.instrumentKey, fraction.numerator, fraction.denominator]),
    ).toEqual([[NEW, 1n, 2n]]);
  });

  it('total cost is conserved (or reported as removed) for any split, conversion or demerger', () => {
    const scenario = fc.record({
      buys: fc.array(
        fc.record({ qty: fc.integer({ min: 1, max: 40 }), price: fc.integer({ min: 1, max: 900 }) }),
        {
          minLength: 1,
          maxLength: 5,
        },
      ),
      sold: fc.integer({ min: 0, max: 100 }),
      type: fc.constantFrom('SPLIT', 'CONVERSION', 'DEMERGER'),
      ratioNum: fc.bigInt({ min: 1n, max: 12n }),
      ratioDen: fc.bigInt({ min: 1n, max: 12n }),
      costSplitBp: fc.bigInt({ min: 0n, max: 10_000n }),
    });
    fc.assert(
      fc.property(scenario, ({ buys, sold, type, ratioNum, ratioDen, costSplitBp }) => {
        const fills = buys.map((entry, index) =>
          buy(entry.qty, entry.price, `2025-01-0${String(index + 1)} 10:00`),
        );
        const held = buys.reduce((sum, entry) => sum + entry.qty, 0);
        const sellQty = Math.min(sold, held);
        if (sellQty > 0) fills.push(sell(sellQty, 1, '2025-02-01 10:00'));
        const moves = type !== 'SPLIT';
        const corporate = action({
          type,
          newIsin: moves ? NEW : null,
          ratioNum,
          ratioDen,
          costSplitBp: type === 'DEMERGER' ? costSplitBp : null,
        });
        const { positions, fractions } = reconstructAccount(fills, [], [corporate]);
        const cost = positions
          .flatMap((position) => position.lots)
          .reduce((sum, lot) => sum + lot.entryValueMicro, 0n);
        const removed = fractions.reduce((sum, fraction) => sum + fraction.costRemovedMicro, 0n);
        const paid = fills
          .filter((entry) => entry.side === 'BUY')
          .reduce((sum, entry) => sum + entry.valueMicro, 0n);
        expect(cost + removed).toBe(paid);
      }),
    );
  });

  it('a reverse split that leaves no whole share reports the cost it removes', () => {
    const { fractions } = reconstructAccount(
      [buy(3, 100, '2025-01-01 10:00')],
      [],
      [action({ ratioNum: 1n, ratioDen: 10n })],
    );
    expect(fractions.map((fraction) => fraction.costRemovedMicro)).toEqual([300n * RUPEE]);
  });
});

describe('interactions', () => {
  it('an exclusion follows the position into its demerger child', () => {
    const fills = [buy(10, 100, '2025-01-01 10:00')];
    const anchorKey = first(reconstructAccount(fills, []).positions).anchorKey;
    const exclusion: Adjustment = { id: 'x', kind: 'exclude', accountId: 'acc', anchorKey };
    const demerger = action({
      type: 'DEMERGER',
      newIsin: NEW,
      ratioNum: 1n,
      ratioDen: 1n,
      costSplitBp: 3000n,
    });
    const { positions } = reconstructAccount(fills, [exclusion], [demerger]);
    expect(positions.map((position) => [position.instrumentKey, position.excluded])).toEqual([
      [OLD, true],
      [NEW, true],
    ]);
  });

  it('opening lots before the ex-date are reshaped like real buys', () => {
    const lot: Adjustment = {
      id: 'lot',
      kind: 'opening_lot',
      accountId: 'acc',
      instrumentKey: OLD,
      bucket: 'DELIVERY',
      quantity: 10n,
      totalCostMicro: 5000n * RUPEE,
      beforeDateIst: '2025-01-01',
    };
    const { positions } = reconstructAccount([sell(50, 110, '2025-04-01 10:00')], [lot], [action({})]);
    expect([first(positions).incomplete, lotsOf(first(positions))]).toEqual([
      false,
      ['50 5000 2024-12-31->5500'],
    ]);
  });

  it('redundantOpeningLots counts shares through a split', () => {
    const fills = [buy(100, 100, '2025-01-01 10:00'), sell(500, 30, '2025-04-01 10:00')];
    const lot: Adjustment = {
      id: 'lot',
      kind: 'opening_lot',
      accountId: 'acc',
      instrumentKey: OLD,
      bucket: 'DELIVERY',
      quantity: 100n,
      totalCostMicro: 10_000n * RUPEE,
      entryDateIst: '2025-01-02',
    };
    expect(redundantOpeningLots(fills, [lot])).toEqual([]);
    expect(redundantOpeningLots(fills, [lot], [action({})])).toEqual(['lot']);
  });

  it('redundantOpeningLots follows a conversion to the new ISIN', () => {
    const conversion = action({ type: 'CONVERSION', newIsin: NEW, ratioNum: 1n, ratioDen: 1n });
    const fills = [buy(100, 100, '2025-01-01 10:00'), sell(100, 30, '2025-04-01 10:00', NEW)];
    const lot: Adjustment = {
      id: 'lot',
      kind: 'opening_lot',
      accountId: 'acc',
      instrumentKey: OLD,
      bucket: 'DELIVERY',
      quantity: 100n,
      totalCostMicro: 10_000n * RUPEE,
      entryDateIst: '2025-01-02',
    };
    expect(redundantOpeningLots(fills, [lot], [conversion])).toEqual(['lot']);
  });

  it('two actions on one ISIN with a sale between them', () => {
    const fills = [
      buy(10, 100, '2025-01-01 10:00'),
      sell(5, 60, '2025-02-15 10:00'),
      sell(45, 30, '2025-04-01 10:00'),
    ];
    const actions = [
      action({ id: 'a', exDateIst: '2025-02-01', ratioNum: 2n }),
      action({ id: 'b', exDateIst: '2025-03-01', ratioNum: 3n }),
    ];
    const position = first(reconstructAccount(fills, [], actions).positions);
    expect([position.incomplete, lotsOf(position)]).toEqual([
      false,
      ['5 250 2025-01-01->300', '45 750 2025-01-01->1350'],
    ]);
  });

  it('a bonus on a holding in two buckets adds one lot per bucket', () => {
    const fills = [buy(4, 100, '2025-01-01 10:00', 'MTF'), buy(6, 100, '2025-01-02 10:00')];
    const bonus = action({ type: 'BONUS', ratioNum: 1n, ratioDen: 2n });
    const { positions } = reconstructAccount(fills, [], [bonus]);
    expect(positions.map((position) => [position.bucket, lotsOf(position)])).toEqual([
      ['DELIVERY', ['6 600 2025-01-02->open', '3 0 2025-03-01->open']],
      ['MTF', ['4 400 2025-01-01->open', '2 0 2025-03-01->open']],
    ]);
  });
});

describe('preview of an edit', () => {
  it('leaves out the stored version of the action being edited', () => {
    const stored = action({ exDateIst: '2025-02-01', ratioNum: 2n });
    const edited = action({ exDateIst: '2025-03-01', ratioNum: 3n });
    const preview = previewCorporateAction([buy(5, 100, '2025-01-01 10:00')], [], edited, [stored]);
    expect(preview.before.map((lot) => lot.quantity)).toEqual([5n]);
    expect(preview.after.map((lot) => lot.quantity)).toEqual([15n]);
  });

  it('shows a demerger child alongside the reshaped parent', () => {
    const demerger = action({
      type: 'DEMERGER',
      newIsin: NEW,
      ratioNum: 1n,
      ratioDen: 1n,
      costSplitBp: 3000n,
    });
    const preview = previewCorporateAction([buy(10, 100, '2025-01-01 10:00')], [], demerger);
    expect(preview.after.map((lot) => [lot.instrumentKey, lot.quantity, lot.costMicro])).toEqual([
      [OLD, 10n, 700n * RUPEE],
      [NEW, 10n, 300n * RUPEE],
    ]);
  });
});

describe('demerger with no child shares over several lots', () => {
  it('returns the child cost to the last parent lot, keeping each lot whole', () => {
    const demerger = action({
      type: 'DEMERGER',
      newIsin: NEW,
      ratioNum: 1n,
      ratioDen: 10n,
      costSplitBp: 2000n,
    });
    const fills = [buy(2, 100, '2025-01-01 10:00'), buy(3, 100, '2025-01-02 10:00')];
    const { positions } = reconstructAccount(fills, [], [demerger]);
    expect(lotsOf(first(positions))).toEqual(['2 160 2025-01-01->open', '3 340 2025-01-02->open']);
  });
});
