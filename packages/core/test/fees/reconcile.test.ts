// S12b (ADR-0017, PRD §8.2): broker statements reconcile the engine's estimates. Reported charges replace the
// estimates wherever a statement covers the trade date, allocated to the (date, instrument) group's allocations by
// value with exact sums. Tolerances: ±₹0.01 per component per statement row; STT and stamp duty compared per day
// against the day's billed total rounded to the rupee. A discrepancy still uses the reported value.
import { describe, expect, it } from 'vitest';
import {
  crossCheckLots,
  positionChargeStatus,
  reconcileCharges,
  type ChargedAllocation,
  type EstimatedCharge,
  type StatementChargeRow,
} from '../../src/index.js';

const PAISA = 10_000n;
const RUPEE = 1_000_000n;
const FY = [{ from: '2024-04-01', to: '2025-03-31' }];

const allocation = (
  key: string,
  dateIst: string,
  instrumentKey: string,
  valueMicro: bigint,
): ChargedAllocation => ({
  allocationKey: key,
  dateIst,
  instrumentKey,
  valueMicro,
});
const estimate = (allocationKey: string, component: EstimatedCharge['component'], amountMicro: bigint) => ({
  allocationKey,
  component,
  amountMicro,
});
const row = (dateIst: string, instrumentKey: string | null, amounts: StatementChargeRow['amounts']) => ({
  dateIst,
  instrumentKey,
  amounts,
});

/** Two buys of one scrip on one day (values 3:1), billed ₹20 brokerage and ₹1 STT. */
const TWO_FILLS = [
  allocation('f1#DELIVERY', '2024-05-02', 'INE1', 300_000n * RUPEE),
  allocation('f2#DELIVERY', '2024-05-02', 'INE1', 100_000n * RUPEE),
];

describe('reconcileCharges', () => {
  it('replaces matching estimates with the reported amounts, split by value with exact sums', () => {
    const result = reconcileCharges({
      allocations: TWO_FILLS,
      estimated: [
        estimate('f1#DELIVERY', 'brokerage', 15n * RUPEE),
        estimate('f2#DELIVERY', 'brokerage', 5n * RUPEE),
        estimate('f1#DELIVERY', 'stt', 750_000n),
        estimate('f2#DELIVERY', 'stt', 250_000n),
      ],
      rows: [row('2024-05-02', 'INE1', { brokerage: 20n * RUPEE, stt: RUPEE + 1n })],
      coverage: FY,
    });
    expect(result.reported).toEqual([
      { allocationKey: 'f1#DELIVERY', component: 'brokerage', amountMicro: 15n * RUPEE },
      { allocationKey: 'f2#DELIVERY', component: 'brokerage', amountMicro: 5n * RUPEE },
      { allocationKey: 'f1#DELIVERY', component: 'stt', amountMicro: 750_001n },
      { allocationKey: 'f2#DELIVERY', component: 'stt', amountMicro: 250_000n },
    ]);
    expect(result.status.get('f1#DELIVERY')).toBe('reconciled');
    expect(result.status.get('f2#DELIVERY')).toBe('reconciled');
    expect(result.discrepancies).toEqual([]);
    expect(result.unmatchedRows).toEqual([]);
  });

  it('a component off by more than ₹0.01 per row is a discrepancy; the reported value is still used', () => {
    const result = reconcileCharges({
      allocations: TWO_FILLS.slice(0, 1),
      estimated: [estimate('f1#DELIVERY', 'brokerage', 20n * RUPEE)],
      rows: [row('2024-05-02', 'INE1', { brokerage: 21n * RUPEE })],
      coverage: FY,
    });
    expect(result.status.get('f1#DELIVERY')).toBe('discrepancy');
    expect(result.discrepancies).toEqual([
      {
        scope: 'row',
        dateIst: '2024-05-02',
        instrumentKey: 'INE1',
        component: 'brokerage',
        estimatedMicro: 20n * RUPEE,
        reportedMicro: 21n * RUPEE,
      },
    ]);
    expect(result.reported).toEqual([
      { allocationKey: 'f1#DELIVERY', component: 'brokerage', amountMicro: 21n * RUPEE },
    ]);
  });

  it('tolerates ₹0.01 per statement row', () => {
    const rows = [
      row('2024-05-02', 'INE1', { gst: 100n * PAISA }),
      row('2024-05-02', 'INE1', { gst: 100n * PAISA }),
    ];
    const within = reconcileCharges({
      allocations: TWO_FILLS,
      estimated: [estimate('f1#DELIVERY', 'gst', 202n * PAISA)],
      rows,
      coverage: FY,
    });
    expect(within.discrepancies).toEqual([]);
    const beyond = reconcileCharges({
      allocations: TWO_FILLS,
      estimated: [estimate('f1#DELIVERY', 'gst', 203n * PAISA)],
      rows,
      coverage: FY,
    });
    expect(beyond.discrepancies.map((entry) => entry.component)).toEqual(['gst']);
  });

  it('compares STT and stamp duty per day, against the billed total rounded to the rupee', () => {
    const allocations = [
      allocation('a#DELIVERY', '2024-09-18', 'INE1', 100n * RUPEE),
      allocation('b#DELIVERY', '2024-09-18', 'INE2', 100n * RUPEE),
    ];
    // Per-scrip STT rows split a rupee-rounded contract-note total: 19.99 + 20.03 = 40.02 → ₹40.
    const rows = [
      row('2024-09-18', 'INE1', { stt: 19_990_000n }),
      row('2024-09-18', 'INE2', { stt: 20_030_000n }),
    ];
    const matching = reconcileCharges({
      allocations,
      estimated: [estimate('a#DELIVERY', 'stt', 20n * RUPEE), estimate('b#DELIVERY', 'stt', 20n * RUPEE)],
      rows,
      coverage: FY,
    });
    expect(matching.discrepancies).toEqual([]);
    const off = reconcileCharges({
      allocations,
      estimated: [estimate('a#DELIVERY', 'stt', 20n * RUPEE), estimate('b#DELIVERY', 'stt', 19n * RUPEE)],
      rows,
      coverage: FY,
    });
    expect(off.discrepancies).toEqual([
      {
        scope: 'day',
        dateIst: '2024-09-18',
        instrumentKey: null,
        component: 'stt',
        estimatedMicro: 39n * RUPEE,
        reportedMicro: 40_020_000n,
      },
    ]);
    // A day-level difference marks every allocation of that day.
    expect([off.status.get('a#DELIVERY'), off.status.get('b#DELIVERY')]).toEqual([
      'discrepancy',
      'discrepancy',
    ]);
  });

  it('leaves trades outside the statement period estimated', () => {
    const result = reconcileCharges({
      allocations: [allocation('f#DELIVERY', '2025-06-02', 'INE1', RUPEE)],
      estimated: [estimate('f#DELIVERY', 'brokerage', RUPEE)],
      rows: [],
      coverage: FY,
    });
    expect(result.status.get('f#DELIVERY')).toBe('estimated');
    expect(result.reported).toEqual([]);
  });

  it('a covered trade with no statement row keeps its estimate and is a discrepancy', () => {
    const result = reconcileCharges({
      allocations: [allocation('f#DELIVERY', '2024-05-02', 'INE9', RUPEE)],
      estimated: [estimate('f#DELIVERY', 'brokerage', 20n * RUPEE)],
      rows: [row('2024-05-02', 'INE1', { brokerage: 20n * RUPEE })],
      coverage: FY,
    });
    expect(result.status.get('f#DELIVERY')).toBe('discrepancy');
    expect(result.reported).toEqual([]);
    expect(result.discrepancies).toEqual([
      {
        scope: 'missing',
        dateIst: '2024-05-02',
        instrumentKey: 'INE9',
        component: 'brokerage',
        estimatedMicro: 20n * RUPEE,
        reportedMicro: 0n,
      },
    ]);
    // The row for a scrip with no trade (or an unresolved scrip) is reported back, not dropped.
    expect(result.unmatchedRows).toEqual([row('2024-05-02', 'INE1', { brokerage: 20n * RUPEE })]);
  });

  it('a group whose allocations carry no value spreads the reported amount evenly', () => {
    const result = reconcileCharges({
      allocations: [
        allocation('x#DELIVERY', '2024-05-02', 'INE1', 0n),
        allocation('y#DELIVERY', '2024-05-02', 'INE1', 0n),
      ],
      estimated: [],
      rows: [row('2024-05-02', 'INE1', { brokerage: 3n })],
      coverage: FY,
    });
    expect(result.reported.map((entry) => entry.amountMicro)).toEqual([2n, 1n]);
  });
});

describe('positionChargeStatus', () => {
  it('discrepancy wins, then estimated; a position with no charged allocation is estimated', () => {
    const status = new Map([
      ['a', 'reconciled'],
      ['b', 'estimated'],
      ['c', 'discrepancy'],
    ] as const);
    expect(positionChargeStatus(['a'], status)).toBe('FEES_RECONCILED');
    expect(positionChargeStatus(['a', 'b'], status)).toBe('FEES_ESTIMATED');
    expect(positionChargeStatus(['a', 'b', 'c'], status)).toBe('FEES_DISCREPANCY');
    expect(positionChargeStatus(['zz'], status)).toBe('FEES_ESTIMATED');
  });
});

describe('crossCheckLots', () => {
  const lot = (
    isin: string,
    buyDateIst: string,
    sellDateIst: string,
    quantity: bigint,
    buyValueMicro: bigint,
  ) => ({
    isin,
    buyDateIst,
    sellDateIst,
    quantity,
    buyValueMicro,
  });

  it('matches lots by ISIN, buy and sell date, summing split lots, within ₹0.10 per statement lot', () => {
    const ours = [
      lot('INE1', '2024-05-02', '2024-06-03', 6n, 600n * RUPEE),
      lot('INE1', '2024-05-02', '2024-06-03', 4n, 400n * RUPEE),
    ];
    const theirs = [lot('INE1', '2024-05-02', '2024-06-03', 10n, 1000n * RUPEE + 60_000n)];
    expect(crossCheckLots(ours, theirs, FY)).toEqual([]);
  });

  it('reports a lot the statement has and we do not, and the reverse inside its period only', () => {
    const theirs = [lot('INE1', '2024-09-17', '2024-09-18', 200n, 35_200n * RUPEE)];
    const ours = [
      lot('INE2', '2024-05-02', '2024-06-03', 1n, RUPEE),
      lot('INE3', '2025-05-02', '2025-06-03', 1n, RUPEE),
    ];
    expect(crossCheckLots(ours, theirs, FY)).toEqual([
      {
        isin: 'INE1',
        buyDateIst: '2024-09-17',
        sellDateIst: '2024-09-18',
        ourQuantity: 0n,
        statementQuantity: 200n,
        ourValueMicro: 0n,
        statementValueMicro: 35_200n * RUPEE,
      },
      {
        isin: 'INE2',
        buyDateIst: '2024-05-02',
        sellDateIst: '2024-06-03',
        ourQuantity: 1n,
        statementQuantity: 0n,
        ourValueMicro: RUPEE,
        statementValueMicro: 0n,
      },
    ]);
  });

  it('reports a quantity or a value beyond tolerance', () => {
    const theirs = [lot('INE1', '2024-05-02', '2024-06-03', 10n, 1000n * RUPEE)];
    expect(
      crossCheckLots([lot('INE1', '2024-05-02', '2024-06-03', 9n, 1000n * RUPEE)], theirs, FY),
    ).toHaveLength(1);
    expect(
      crossCheckLots([lot('INE1', '2024-05-02', '2024-06-03', 10n, 1001n * RUPEE)], theirs, FY),
    ).toHaveLength(1);
  });
});
