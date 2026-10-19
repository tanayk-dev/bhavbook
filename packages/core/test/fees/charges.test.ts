// S12a tasks 2, 3 and 5 (ADR-0016): charges per billing unit, rounded as the broker bills, allocated to fills.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bundledFeeRules, computeCharges } from '../../src/index.js';
import { RUPEE } from '../fifo/helpers.js';
import { charge, chargeable, PAISA, total } from './helpers.js';

const buy = (qty: number, price: number | string, at: string, instrument = 'A', product: 'DELIVERY' | 'MTF' = 'DELIVERY') =>
  chargeable({ side: 'BUY', qty, price, at, instrument, product });
const sell = (qty: number, price: number | string, at: string, instrument = 'A', product: 'DELIVERY' | 'MTF' = 'DELIVERY') =>
  chargeable({ side: 'SELL', qty, price, at, instrument, product });

describe('contract-note statutory charges (Dhan, 22 Apr 2024: three delivery buys)', () => {
  const fills = [
    buy(75, '203.4333333', '2024-04-22 10:00', 'Electrosteel'),
    buy(2, '3673.80', '2024-04-22 10:01', 'Gujarat Fluoro'),
    buy(5, '1653.00', '2024-04-22 10:02', 'Sobha'),
  ];
  // Electrosteel's value is pinned to the statement's 15,257.50.
  const pinned = fills.map((entry, index) => (index === 0 ? { ...entry, valueMicro: 15_257_500_000n } : entry));
  const { charges } = charge('dhan', pinned);

  it('STT: one rupee-rounded total per contract note (Rs 30.8701 -> Rs 31), split across the fills', () => {
    expect(total(charges, 'stt')).toBe(31n * RUPEE);
  });

  it('stamp duty: 0.015% of delivery buys, rounded to the rupee (Rs 4.63 -> Rs 5)', () => {
    expect(total(charges, 'stamp_duty')).toBe(5n * RUPEE);
  });

  it('txn 0.00322% (before 1 Oct 2024), SEBI and IPFT per contract note at paise', () => {
    expect([total(charges, 'exchange_txn'), total(charges, 'sebi'), total(charges, 'ipft')]).toEqual([
      99n * PAISA,
      3n * PAISA,
      3n * PAISA,
    ]);
  });

  it('GST is 18% of brokerage + txn + SEBI + IPFT only (never STT or stamp duty)', () => {
    // (0 + 0.99 + 0.03 + 0.03) x 18% = 0.189 -> 0.19.
    expect(total(charges, 'gst')).toBe(19n * PAISA);
  });

  it('delivery is brokerage-free, and buys carry no DP', () => {
    expect([total(charges, 'brokerage'), total(charges, 'dp')]).toEqual([0n, 0n]);
  });
});

describe('rule versions across 2024-10-01', () => {
  it('the same trade pays 0.00322% before and 0.00297% after', () => {
    const before = charge('dhan', [buy(1, 100_000, '2024-09-30 10:00')]).charges;
    const after = charge('dhan', [buy(1, 100_000, '2024-10-01 10:00')]).charges;
    expect([total(before, 'exchange_txn'), total(after, 'exchange_txn')]).toEqual([322n * PAISA, 297n * PAISA]);
  });
});

describe('intraday (same-day netting) and brokerage', () => {
  it('Dhan 23 Apr 2024 RVNL: brokerage per order 2.07 + 2.08, STT 0.025% of the sell only', () => {
    const fills = [buy(25, '276.20', '2024-04-23 10:00'), sell(25, '276.85', '2024-04-23 11:00')];
    const { charges } = charge('dhan', fills);
    expect(total(charges, 'brokerage')).toBe(415n * PAISA);
    // 6921.25 x 0.025% = 1.73 -> Rs 2 for this contract note on its own.
    expect(total(charges, 'stt')).toBe(2n * RUPEE);
    expect(total(charges, 'stt', fills[0]?.id)).toBe(0n);
  });

  it('E12: an MTF buy sold the same day is charged as intraday (no delivery STT on the buy)', () => {
    const fills = [buy(100, 500, '2024-11-05 10:00', 'A', 'MTF'), sell(100, 510, '2024-11-05 14:00', 'A', 'MTF')];
    const { charges } = charge('dhan', fills);
    expect(total(charges, 'stt')).toBe(13n * RUPEE); // 51,000 x 0.025% = 12.75 -> 13
    expect(total(charges, 'stamp_duty')).toBe(2n * RUPEE); // 50,000 x 0.003% = 1.50 -> 2
  });

  it('brokerage is capped at Rs 20 per order', () => {
    const fills = [buy(1000, 100, '2024-11-05 10:00'), sell(1000, 101, '2024-11-05 14:00')];
    expect(total(charge('dhan', fills).charges, 'brokerage')).toBe(40n * RUPEE);
  });

  it('Zerodha MTF brokerage: 0.3% or Rs 20 per order; delivery stays free', () => {
    const mtf = [buy(10, 500, '2025-11-05 10:00', 'A', 'MTF')];
    const override = [{ accountId: 'acc', instrumentKey: 'A', tradeDateIst: '2025-11-05', bucket: 'MTF' as const }];
    expect(total(charge('zerodha', mtf, override).charges, 'brokerage')).toBe(15n * RUPEE); // 5000 x 0.3%
    expect(total(charge('zerodha', [buy(100, 500, '2025-11-05 10:00')]).charges, 'brokerage')).toBe(0n);
    const big = [buy(100, 500, '2025-11-05 10:00', 'A', 'MTF')];
    expect(total(charge('zerodha', big, override).charges, 'brokerage')).toBe(20n * RUPEE);
  });

  it('fills of one Zerodha order share one brokerage cap', () => {
    const order = (qty: number, at: string) =>
      chargeable({ side: 'BUY', qty, price: 1000, at, instrument: 'A', order: 'o1', granularity: 'fill' });
    const fills = [order(50, '2025-11-05 10:00'), order(50, '2025-11-05 10:00:01'), sell(100, 1000, '2025-11-05 14:00')];
    // Buy order 1,00,000 x 0.03% = 30 -> capped at 20; the sell order also 20.
    expect(total(charge('zerodha', fills).charges, 'brokerage')).toBe(40n * RUPEE);
  });
});

describe('DP charges per (instrument, delivery sell day), inclusive of their GST', () => {
  it('Dhan: Rs 12.50 + 18% GST = Rs 14.75 once per scrip per day, whatever the number of sells', () => {
    const fills = [sell(5, 100, '2024-11-05 10:00'), sell(5, 100, '2024-11-05 11:00'), sell(1, 100, '2024-11-05 11:00', 'B')];
    expect(total(charge('dhan', fills).charges, 'dp')).toBe(2n * 1475n * PAISA);
  });

  it('Zerodha: Rs 15.93 until 31 May 2024, Rs 15.34 from 1 June 2024', () => {
    expect(total(charge('zerodha', [sell(1, 100, '2024-05-31 10:00')]).charges, 'dp')).toBe(1593n * PAISA);
    expect(total(charge('zerodha', [sell(1, 100, '2024-06-03 10:00')]).charges, 'dp')).toBe(1534n * PAISA);
  });

  it('intraday sells pay no DP', () => {
    const fills = [buy(1, 100, '2024-11-05 10:00'), sell(1, 101, '2024-11-05 11:00')];
    expect(total(charge('dhan', fills).charges, 'dp')).toBe(0n);
  });
});

describe('coverage of the rules', () => {
  it('fills with no rule version in force are reported unrated and get no charges', () => {
    const early = buy(1, 100, '2024-03-28 10:00');
    const bse = chargeable({ side: 'BUY', qty: 1, price: 100, at: '2024-09-02 10:00', instrument: 'B', exchange: 'BSE' });
    const { charges, unrated } = charge('dhan', [early, bse]);
    expect(charges).toEqual([]);
    expect(unrated).toEqual([early.id, bse.id]);
  });

  it('records the rule versions behind every charge', () => {
    const { charges } = charge('zerodha', [sell(1, 100, '2025-11-05 10:00')]);
    expect(new Set(charges.map((entry) => entry.ruleVersion))).toEqual(new Set(['nse/2024-10-01+zerodha/2024-06-01']));
  });

  it('BSE trades use the BSE version', () => {
    const fills = [chargeable({ side: 'BUY', qty: 1, price: 100_000, at: '2025-10-01 10:00', exchange: 'BSE' })];
    expect(total(charge('zerodha', fills).charges, 'exchange_txn')).toBe(375n * PAISA);
  });
});

describe('allocation', () => {
  it('every contract-note total is split exactly over its fills (property)', () => {
    const trades = fc.array(
      fc.record({
        side: fc.constantFrom('BUY' as const, 'SELL' as const),
        qty: fc.integer({ min: 1, max: 500 }),
        paise: fc.integer({ min: 100, max: 500_000 }),
        minute: fc.integer({ min: 0, max: 59 }),
        instrument: fc.constantFrom('A', 'B', 'C'),
      }),
      { minLength: 1, maxLength: 12 },
    );
    fc.assert(
      fc.property(trades, (specs) => {
        const fills = specs.map((spec) =>
          chargeable({
            side: spec.side,
            qty: spec.qty,
            price: `${String(Math.floor(spec.paise / 100))}.${String(spec.paise % 100).padStart(2, '0')}`,
            at: `2025-11-05 10:${String(spec.minute).padStart(2, '0')}`,
            instrument: spec.instrument,
            product: 'DELIVERY',
          }),
        );
        const { charges, allocations } = charge('dhan', fills);
        const keys = new Set(allocations.map((allocation) => allocation.key));
        expect(charges.every((entry) => keys.has(entry.allocationKey) && entry.amountMicro > 0n)).toBe(true);
        // Rupee-rounded components stay whole rupees in total; paise ones whole paise.
        expect(total(charges, 'stt') % RUPEE).toBe(0n);
        expect(total(charges, 'stamp_duty') % RUPEE).toBe(0n);
        expect(total(charges, 'exchange_txn') % PAISA).toBe(0n);
        expect(total(charges, 'gst') % PAISA).toBe(0n);
      }),
    );
  });

  it('opening lots and other synthetic allocations are never charged', () => {
    const fills = [buy(1, 100, '2025-11-05 10:00')];
    const { allocations } = charge('dhan', fills);
    const synthetic = { ...allocations[0], key: 'adj:x#DELIVERY', fillId: 'adj:x', adjustmentId: 'x' };
    expect(computeCharges({ broker: 'dhan', fills, allocations: [synthetic as never], rules: bundledFeeRules() }).charges).toEqual([]);
  });
});
