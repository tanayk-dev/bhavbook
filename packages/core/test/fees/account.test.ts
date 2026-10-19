// S12a-2: an account's charges, computed on the trades as imported and carried onto the allocations a
// reconstruction ends with (corporate actions reshape allocations; charges stay with the trade).
import { describe, expect, it } from 'vitest';
import {
  bundledFeeRules,
  chargeAccount,
  reconstructAccount,
  type Adjustment,
  type CorporateAction,
} from '../../src/index.js';
import { RUPEE } from '../fifo/helpers.js';
import { chargeable } from './helpers.js';

const split: CorporateAction = {
  id: 'ca1',
  type: 'SPLIT',
  isin: 'A',
  newIsin: null,
  exDateIst: '2025-03-03',
  allotmentDateIst: null,
  ratioNum: 2n,
  ratioDen: 1n,
  costSplitBp: null,
};

describe('chargeAccount', () => {
  const fills = [
    chargeable({
      side: 'BUY',
      qty: 10,
      price: 1000,
      at: '2025-01-02 10:00',
      product: 'DELIVERY',
      instrument: 'A',
    }),
    chargeable({
      side: 'SELL',
      qty: 4,
      price: 1100,
      at: '2025-02-03 10:00',
      product: 'DELIVERY',
      instrument: 'A',
    }),
  ];

  it('spreads a buy charge over the parts a corporate action left, by value, exactly', () => {
    const { allocations } = reconstructAccount(fills, [], [split]);
    const { charges } = chargeAccount({
      broker: 'dhan',
      fills,
      adjustments: [],
      allocations,
      rules: bundledFeeRules(),
    });
    const buyKey = allocations.find((allocation) => allocation.side === 'BUY')?.key ?? '';
    const stt = charges.filter(
      (charge) => charge.component === 'stt' && charge.allocationKey.startsWith(buyKey),
    );
    // Rs 10,000 x 0.1% = Rs 10, split 4,000 : 6,000 over the sold part and the split part.
    expect(stt.map((charge) => [charge.allocationKey, charge.amountMicro])).toEqual([
      [buyKey, 4n * RUPEE],
      [`${buyKey}~ca1`, 6n * RUPEE],
    ]);
  });

  it('is the plain engine result when nothing reshaped the allocations', () => {
    const { allocations } = reconstructAccount(fills, []);
    const { charges, unrated } = chargeAccount({
      broker: 'dhan',
      fills,
      adjustments: [],
      allocations,
      rules: bundledFeeRules(),
    });
    expect(unrated).toEqual([]);
    expect(new Set(charges.map((charge) => charge.allocationKey))).toEqual(
      new Set(allocations.map((allocation) => allocation.key)),
    );
  });

  it('never charges opening lots, and honours product overrides', () => {
    const lot: Adjustment = {
      id: 'lot',
      kind: 'opening_lot',
      accountId: 'acc',
      instrumentKey: 'A',
      bucket: 'DELIVERY',
      quantity: 5n,
      totalCostMicro: 5000n * RUPEE,
      beforeDateIst: '2025-01-01',
    };
    const override: Adjustment = {
      id: 'o',
      kind: 'product_override',
      accountId: 'acc',
      instrumentKey: 'A',
      tradeDateIst: '2025-01-02',
      bucket: 'MTF',
    };
    const { allocations } = reconstructAccount(fills, [lot, override]);
    const { charges } = chargeAccount({
      broker: 'dhan',
      fills,
      adjustments: [lot, override],
      allocations,
      rules: bundledFeeRules(),
    });
    expect(charges.some((charge) => charge.allocationKey.startsWith('adj:'))).toBe(false);
    // The MTF buy pays MTF brokerage: Rs 10,000 x 0.03% = Rs 3.
    const brokerage = charges.filter((charge) => charge.component === 'brokerage');
    expect(brokerage.reduce((sum, charge) => sum + charge.amountMicro, 0n)).toBe(3n * RUPEE);
  });
});

describe('chargeAccount when shares are cashed out by a corporate action', () => {
  const reverse = { ...split, ratioNum: 1n, ratioDen: 10n };
  const total = (charges: readonly { amountMicro: bigint }[]): bigint =>
    charges.reduce((sum, charge) => sum + charge.amountMicro, 0n);

  it('reports the charges of a holding cashed out entirely as unattached (never dropped)', () => {
    const fills = [
      chargeable({
        side: 'BUY',
        qty: 3,
        price: 1000,
        at: '2025-01-02 10:00',
        product: 'DELIVERY',
        instrument: 'A',
      }),
    ];
    const { allocations } = reconstructAccount(fills, [], [reverse]);
    expect(allocations).toEqual([]);
    const result = chargeAccount({
      broker: 'dhan',
      fills,
      adjustments: [],
      allocations,
      rules: bundledFeeRules(),
    });
    expect(result.charges).toEqual([]);
    expect(total(result.unattached)).toBe(
      total(
        chargeAccount({
          broker: 'dhan',
          fills,
          adjustments: [],
          allocations: reconstructAccount(fills, []).allocations,
          rules: bundledFeeRules(),
        }).charges,
      ),
    );
  });

  it('keeps only the sold share of a partly cashed-out buy on its sold part', () => {
    const fills = [
      chargeable({
        side: 'BUY',
        qty: 10,
        price: 1000,
        at: '2025-01-02 10:00',
        product: 'DELIVERY',
        instrument: 'A',
      }),
      chargeable({
        side: 'SELL',
        qty: 3,
        price: 1000,
        at: '2025-02-03 10:00',
        product: 'DELIVERY',
        instrument: 'A',
      }),
    ];
    const { allocations } = reconstructAccount(fills, [], [reverse]);
    const { charges, unattached } = chargeAccount({
      broker: 'dhan',
      fills,
      adjustments: [],
      allocations,
      rules: bundledFeeRules(),
    });
    const buyKey = `${fills[0]?.id ?? ''}#DELIVERY`;
    const stt = (list: typeof charges) =>
      list
        .filter((charge) => charge.component === 'stt' && charge.allocationKey === buyKey)
        .map((charge) => charge.amountMicro);
    // Buy STT Rs 10: 3/10 stays with the 3 shares sold, 7/10 left with the shares cashed out.
    expect([stt(charges), stt(unattached)]).toEqual([[3n * RUPEE], [7n * RUPEE]]);
  });
});

describe('chargeAccount and bonus lots', () => {
  it('a bonus lot carries no charge; the buy keeps all of its own', () => {
    const fills = [
      chargeable({
        side: 'BUY',
        qty: 10,
        price: 1000,
        at: '2025-01-02 10:00',
        product: 'DELIVERY',
        instrument: 'A',
      }),
    ];
    const bonus: CorporateAction = { ...split, type: 'BONUS', ratioNum: 1n, ratioDen: 1n };
    const { allocations } = reconstructAccount(fills, [], [bonus]);
    const { charges, unattached } = chargeAccount({
      broker: 'dhan',
      fills,
      adjustments: [],
      allocations,
      rules: bundledFeeRules(),
    });
    expect(charges.some((charge) => charge.allocationKey.startsWith('ca:'))).toBe(false);
    expect(unattached).toEqual([]);
  });
});
