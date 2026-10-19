// S10b-1 (ADR-0015, PRD §7.4): corporate actions applied to open lots at the ex-date, inside reconstruction.
import { describe, expect, it } from 'vitest';
import {
  grossPnlMicro,
  InvalidArgumentError,
  previewCorporateAction,
  reconstructAccount,
  type CorporateAction,
  type Position,
  type TradeFill,
} from '../../src/index.js';
import { fill, first, RUPEE, rupees } from '../fifo/helpers.js';

const OLD = 'INE155A01022';
const NEW = 'INE1TAE01010';

function action(overrides: Partial<CorporateAction>): CorporateAction {
  return {
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
}

const buy = (qty: number, price: number | string, at: string, instrument = OLD): TradeFill =>
  fill({ side: 'BUY', qty, price, at, product: 'DELIVERY', instrument });
const sell = (qty: number, price: number | string, at: string, instrument = OLD): TradeFill =>
  fill({ side: 'SELL', qty, price, at, product: 'DELIVERY', instrument });

function run(fills: readonly TradeFill[], actions: readonly CorporateAction[]) {
  return reconstructAccount(fills, [], actions);
}

function lotsOf(position: Position): string[] {
  return position.lots.map(
    (lot) =>
      `${String(lot.quantity)} ${rupees(lot.entryValueMicro)} ${lot.entryDateIst}->${lot.exitValueMicro === null ? 'open' : rupees(lot.exitValueMicro)}`,
  );
}

describe('SPLIT (E8)', () => {
  it('E8: hold 10 @500, split 1:5, sell 50 @110 -> lot 50 @100, gross Rs 500, entry date unchanged', () => {
    const { positions } = run([buy(10, 500, '2025-01-01 10:00'), sell(50, 110, '2025-04-01 10:00')], [action({})]);
    const position = first(positions);
    expect([position.incomplete, rupees(grossPnlMicro(position))]).toEqual([false, '500']);
    expect(lotsOf(position)).toEqual(['50 5000 2025-01-01->5500']);
  });

  it('applies only to the quantity still open at the ex-date', () => {
    const { positions } = run(
      [buy(10, 500, '2025-01-01 10:00'), sell(4, 520, '2025-02-01 10:00'), sell(30, 110, '2025-04-01 10:00')],
      [action({})],
    );
    expect(lotsOf(first(positions))).toEqual(['4 2000 2025-01-01->2080', '30 3000 2025-01-01->3300']);
  });

  it('leaves positions closed before the ex-date, other instruments and intraday alone', () => {
    const fills = [
      buy(10, 500, '2025-01-01 10:00'),
      sell(10, 510, '2025-01-05 10:00'),
      buy(3, 100, '2025-01-01 10:00', 'OTHER'),
      fill({ side: 'BUY', qty: 2, price: 100, at: '2025-03-01 10:00', instrument: OLD }),
      fill({ side: 'SELL', qty: 2, price: 101, at: '2025-03-01 11:00', instrument: OLD }),
    ];
    const { positions } = run(fills, [action({})]);
    expect(positions.map((position) => `${position.instrumentKey} ${position.bucket} ${lotsOf(position).join(',')}`)).toEqual([
      `${OLD} DELIVERY 10 5000 2025-01-01->5100`,
      `${OLD} INTRADAY 2 200 2025-03-01->202`,
      'OTHER DELIVERY 3 300 2025-01-01->open',
    ]);
  });

  it('computes the entitlement on the whole holding and reports the fraction (reverse split 3:2)', () => {
    const { positions, fractions } = run(
      [buy(3, 100, '2025-01-01 10:00'), buy(4, 100, '2025-01-02 10:00')],
      [action({ ratioNum: 2n, ratioDen: 3n })],
    );
    // 7 x 2/3 = 4.67: 4 shares, two-thirds of a share in lieu; cost carried over in full.
    const lots = first(positions).lots;
    expect(lots.reduce((sum, lot) => sum + lot.quantity, 0n)).toBe(4n);
    expect(lots.reduce((sum, lot) => sum + lot.entryValueMicro, 0n)).toBe(700n * RUPEE);
    expect(fractions).toEqual([
      { actionId: 'ca1', accountId: 'acc', instrumentKey: OLD, bucket: 'DELIVERY', numerator: 2n, denominator: 3n },
    ]);
  });
});

describe('BONUS', () => {
  it('1:1 adds a Rs 0 lot dated at allotment; the average halves', () => {
    const bonus = action({ type: 'BONUS', ratioNum: 1n, ratioDen: 1n, allotmentDateIst: '2025-03-04' });
    const { positions } = run([buy(10, 100, '2025-01-01 10:00')], [bonus]);
    const position = first(positions);
    expect(lotsOf(position)).toEqual(['10 1000 2025-01-01->open', '10 0 2025-03-04->open']);
    const quantity = position.lots.reduce((sum, lot) => sum + lot.quantity, 0n);
    const cost = position.lots.reduce((sum, lot) => sum + lot.entryValueMicro, 0n);
    expect(cost / quantity).toBe(50n * RUPEE);
  });

  it('defaults the allotment date to the ex-date, and FIFO sells the original lot first', () => {
    const bonus = action({ type: 'BONUS', ratioNum: 1n, ratioDen: 2n });
    const { positions } = run([buy(10, 100, '2025-01-01 10:00'), sell(12, 120, '2025-05-01 10:00')], [bonus]);
    expect(lotsOf(first(positions))).toEqual(['10 1000 2025-01-01->1200', '2 0 2025-03-01->240', '3 0 2025-03-01->open']);
  });
});

describe('CONVERSION', () => {
  it('moves open lots to the new ISIN at the ratio, carrying cost and dates', () => {
    const conversion = action({ type: 'CONVERSION', newIsin: NEW, ratioNum: 1n, ratioDen: 1n });
    const { positions } = run([buy(10, 100, '2025-01-01 10:00'), sell(10, 130, '2025-04-01 10:00', NEW)], [conversion]);
    expect(positions.map((position) => [position.instrumentKey, position.incomplete, lotsOf(position)])).toEqual([
      [NEW, false, ['10 1000 2025-01-01->1300']],
    ]);
  });
});

describe('DEMERGER', () => {
  it('Tata example: 100 @800, 1:1, 68.85/31.15 -> TMPV Rs 55,080 and TMCV Rs 24,920, dates inherited', () => {
    const demerger = action({ type: 'DEMERGER', newIsin: NEW, ratioNum: 1n, ratioDen: 1n, costSplitBp: 3115n, exDateIst: '2025-10-14' });
    const { positions } = run([buy(100, 800, '2025-01-01 10:00')], [demerger]);
    expect(positions.map((position) => [position.instrumentKey, lotsOf(position)])).toEqual([
      [OLD, ['100 55080 2025-01-01->open']],
      [NEW, ['100 24920 2025-01-01->open']],
    ]);
  });
});

describe('several actions and revert', () => {
  it('applies actions in ex-date order (split, then bonus on the split holding)', () => {
    const split = action({ id: 'a', exDateIst: '2025-02-01', ratioNum: 2n });
    const bonus = action({ id: 'b', type: 'BONUS', exDateIst: '2025-03-01', ratioNum: 1n, ratioDen: 1n });
    const { positions } = run([buy(10, 100, '2025-01-01 10:00')], [bonus, split]);
    expect(lotsOf(first(positions))).toEqual(['20 1000 2025-01-01->open', '20 0 2025-03-01->open']);
  });

  it('revert = leave the action out', () => {
    expect(lotsOf(first(run([buy(10, 500, '2025-01-01 10:00')], []).positions))).toEqual(['10 5000 2025-01-01->open']);
  });

  it('rejects malformed actions', () => {
    for (const bad of [
      action({ ratioNum: 0n }),
      action({ ratioDen: 0n }),
      action({ exDateIst: '2025-02-30' }),
      action({ type: 'CONVERSION', newIsin: null }),
      action({ type: 'DEMERGER', newIsin: NEW, costSplitBp: null }),
      action({ type: 'DEMERGER', newIsin: NEW, costSplitBp: 10_001n }),
      action({ type: 'BONUS', allotmentDateIst: 'x' }),
      action({ type: 'MERGER' as 'SPLIT' }),
    ]) {
      expect(() => run([], [bad])).toThrow(InvalidArgumentError);
    }
    expect(() => run([], [action({}), action({})])).toThrow(InvalidArgumentError);
  });
});

describe('previewCorporateAction', () => {
  it('shows the affected open lots before and after, with the fraction', () => {
    const fills = [buy(3, 100, '2025-01-01 10:00'), buy(4, 100, '2025-01-02 10:00'), sell(1, 100, '2025-01-03 10:00')];
    const preview = previewCorporateAction(fills, [], action({ ratioNum: 2n, ratioDen: 1n }));
    expect(preview.before).toEqual([
      { accountId: 'acc', instrumentKey: OLD, bucket: 'DELIVERY', quantity: 2n, costMicro: 200n * RUPEE, entryDateIst: '2025-01-01' },
      { accountId: 'acc', instrumentKey: OLD, bucket: 'DELIVERY', quantity: 4n, costMicro: 400n * RUPEE, entryDateIst: '2025-01-02' },
    ]);
    expect(preview.after.map((lot) => lot.quantity)).toEqual([4n, 8n]);
    expect(preview.fractions).toEqual([]);
  });
});
