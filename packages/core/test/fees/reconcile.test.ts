// S12b (ADR-0017, PRD §8.2): broker statements reconcile the engine's estimates. Reported charges replace the
// estimates wherever a statement covers the trade date, per (date, exchange, instrument), split in proportion to each
// component's estimates (by value when there are none) with exact sums. Tolerances: ±₹0.01 per component per row;
// STT and stamp duty per contract note (date, exchange) against the billed total rounded to the rupee. A discrepancy
// still uses the reported value.
import { describe, expect, it } from 'vitest';
import {
  crossCheckLots,
  positionChargeStatus,
  reconcileCharges,
  type ChargedAllocation,
  type ChargeComponent,
  type EstimatedCharge,
  type ReconciledComponent,
  type StatementChargeRow,
} from '../../src/index.js';

const PAISA = 10_000n;
const RUPEE = 1_000_000n;
const FY = [{ from: '2024-04-01', to: '2025-03-31' }];
const DAY = '2024-05-02';

const allocation = (
  key: string,
  valueMicro: bigint,
  place: Partial<Omit<ChargedAllocation, 'allocationKey' | 'valueMicro'>> = {},
): ChargedAllocation => ({
  allocationKey: key,
  valueMicro,
  dateIst: DAY,
  exchange: 'NSE',
  instrumentKey: 'INE1',
  ...place,
});

/** An estimate on an allocation, placed where that allocation is. */
const estimate = (
  on: ChargedAllocation | { readonly cashedOut: ChargedAllocation },
  component: ChargeComponent,
  amountMicro: bigint,
): EstimatedCharge => {
  const place = 'cashedOut' in on ? on.cashedOut : on;
  return {
    allocationKey: 'cashedOut' in on ? null : on.allocationKey,
    dateIst: place.dateIst,
    exchange: place.exchange,
    instrumentKey: place.instrumentKey,
    component,
    amountMicro,
  };
};

const row = (
  amounts: Partial<Record<ReconciledComponent, bigint>>,
  place: Partial<Omit<StatementChargeRow, 'amounts'>> = {},
): StatementChargeRow => ({ dateIst: DAY, exchange: 'NSE', instrumentKey: 'INE1', amounts, ...place });

const BUY = allocation('buy#INTRADAY', 300_000n * RUPEE);
const SELL = allocation('sell#INTRADAY', 300_500n * RUPEE);

describe('reconcileCharges', () => {
  it("replaces matching estimates with the reported amounts in the estimates' proportions, with exact sums", () => {
    const result = reconcileCharges({
      allocations: [BUY, SELL],
      estimated: [
        estimate(BUY, 'brokerage', 15n * RUPEE),
        estimate(SELL, 'brokerage', 5n * RUPEE),
        // Intraday STT is on the sell only: the reported STT stays there, whatever the buy's value.
        estimate(SELL, 'stt', 75n * RUPEE),
      ],
      rows: [row({ brokerage: 20n * RUPEE + 1n, stt: 75n * RUPEE })],
      coverage: FY,
    });
    expect(result.reported).toEqual([
      { allocationKey: 'buy#INTRADAY', component: 'brokerage', amountMicro: 15n * RUPEE + 1n },
      { allocationKey: 'sell#INTRADAY', component: 'brokerage', amountMicro: 5n * RUPEE },
      { allocationKey: 'sell#INTRADAY', component: 'stt', amountMicro: 75n * RUPEE },
    ]);
    expect([result.status.get(BUY.allocationKey), result.status.get(SELL.allocationKey)]).toEqual([
      'reconciled',
      'reconciled',
    ]);
    expect(result.discrepancies).toEqual([]);
    expect(result.unmatchedRows).toEqual([]);
    expect(result.reportedUnattachedMicro).toBe(0n);
  });

  it('a component off by more than ₹0.01 per row is a discrepancy; the reported value is still used', () => {
    const result = reconcileCharges({
      allocations: [BUY],
      estimated: [estimate(BUY, 'brokerage', 20n * RUPEE)],
      rows: [row({ brokerage: 21n * RUPEE })],
      coverage: FY,
    });
    expect(result.status.get(BUY.allocationKey)).toBe('discrepancy');
    expect(result.discrepancies).toEqual([
      {
        scope: 'row',
        dateIst: DAY,
        exchange: 'NSE',
        instrumentKey: 'INE1',
        component: 'brokerage',
        estimatedMicro: 20n * RUPEE,
        reportedMicro: 21n * RUPEE,
      },
    ]);
    expect(result.reported).toEqual([
      { allocationKey: BUY.allocationKey, component: 'brokerage', amountMicro: 21n * RUPEE },
    ]);
  });

  it('tolerates ₹0.01 per statement row', () => {
    const rows = [row({ gst: 100n * PAISA }), row({ gst: 100n * PAISA })];
    const reconcile = (gst: bigint) =>
      reconcileCharges({ allocations: [BUY], estimated: [estimate(BUY, 'gst', gst)], rows, coverage: FY });
    expect(reconcile(202n * PAISA).discrepancies).toEqual([]);
    expect(reconcile(203n * PAISA).discrepancies.map((entry) => entry.component)).toEqual(['gst']);
  });

  it('compares STT and stamp duty per contract note, against the billed total rounded to the rupee', () => {
    const a = allocation('a#DELIVERY', 100n * RUPEE, { dateIst: '2024-09-18' });
    const b = allocation('b#DELIVERY', 100n * RUPEE, { dateIst: '2024-09-18', instrumentKey: 'INE2' });
    // Per-scrip rows split a rupee-rounded contract-note total: 19.99 + 20.03 = 40.02 → ₹40.
    const rows = [
      row({ stt: 19_990_000n, stamp_duty: 2n * RUPEE }, { dateIst: '2024-09-18' }),
      row({ stt: 20_030_000n }, { dateIst: '2024-09-18', instrumentKey: 'INE2' }),
    ];
    const reconcile = (bStt: bigint, stamp: bigint) =>
      reconcileCharges({
        allocations: [a, b],
        estimated: [
          estimate(a, 'stt', 20n * RUPEE),
          estimate(b, 'stt', bStt),
          estimate(a, 'stamp_duty', stamp),
        ],
        rows,
        coverage: FY,
      });
    expect(reconcile(20n * RUPEE, 2n * RUPEE).discrepancies).toEqual([]);
    const off = reconcile(19n * RUPEE, 3n * RUPEE);
    expect(off.discrepancies).toEqual([
      {
        scope: 'note',
        dateIst: '2024-09-18',
        exchange: 'NSE',
        instrumentKey: null,
        component: 'stt',
        estimatedMicro: 39n * RUPEE,
        reportedMicro: 40_020_000n,
      },
      {
        scope: 'note',
        dateIst: '2024-09-18',
        exchange: 'NSE',
        instrumentKey: null,
        component: 'stamp_duty',
        estimatedMicro: 3n * RUPEE,
        reportedMicro: 2n * RUPEE,
      },
    ]);
    // A contract-note difference marks every allocation of that note.
    expect([off.status.get('a#DELIVERY'), off.status.get('b#DELIVERY')]).toEqual([
      'discrepancy',
      'discrepancy',
    ]);
  });

  it("rounds each exchange's contract note on its own", () => {
    const nse = allocation('n#DELIVERY', RUPEE);
    const bse = allocation('b#DELIVERY', RUPEE, { exchange: 'BSE' });
    // NSE 12.40 → ₹12 and BSE 7.40 → ₹7: ₹19, not round(19.80) = ₹20.
    const result = reconcileCharges({
      allocations: [nse, bse],
      estimated: [estimate(nse, 'stt', 12n * RUPEE), estimate(bse, 'stt', 7n * RUPEE)],
      rows: [row({ stt: 12_400_000n }), row({ stt: 7_400_000n }, { exchange: 'BSE' })],
      coverage: FY,
    });
    expect(result.discrepancies).toEqual([]);
  });

  it('keeps the share of shares a corporate action cashed out unattached, not loaded onto the rest', () => {
    const kept = allocation('f#DELIVERY~ca', 60n * RUPEE);
    const result = reconcileCharges({
      allocations: [kept],
      estimated: [
        estimate(kept, 'brokerage', 12n * RUPEE),
        estimate({ cashedOut: kept }, 'brokerage', 8n * RUPEE),
      ],
      rows: [row({ brokerage: 20n * RUPEE })],
      coverage: FY,
    });
    expect(result.reported).toEqual([
      { allocationKey: kept.allocationKey, component: 'brokerage', amountMicro: 12n * RUPEE },
    ]);
    expect(result.reportedUnattachedMicro).toBe(8n * RUPEE);
    expect(result.discrepancies).toEqual([]);
  });

  it('a component the engine did not estimate is split by value; one billed at zero replaces the estimate with 0', () => {
    const result = reconcileCharges({
      allocations: [BUY, SELL],
      estimated: [estimate(BUY, 'sebi', 1n), estimate(SELL, 'sebi', 1n)],
      rows: [row({ brokerage: 600_500n, sebi: 0n })],
      coverage: FY,
    });
    expect(result.reported).toEqual([
      { allocationKey: BUY.allocationKey, component: 'brokerage', amountMicro: 300_000n },
      { allocationKey: SELL.allocationKey, component: 'brokerage', amountMicro: 300_500n },
      { allocationKey: BUY.allocationKey, component: 'sebi', amountMicro: 0n },
      { allocationKey: SELL.allocationKey, component: 'sebi', amountMicro: 0n },
    ]);
  });

  it('splits a negative billed amount (a reversal) the same way', () => {
    const result = reconcileCharges({
      allocations: [BUY, SELL],
      estimated: [estimate(BUY, 'brokerage', RUPEE), estimate(SELL, 'brokerage', RUPEE)],
      rows: [row({ brokerage: -3n })],
      coverage: FY,
    });
    expect(result.reported.map((entry) => entry.amountMicro)).toEqual([-2n, -1n]);
  });

  it('spreads evenly over allocations that carry no value', () => {
    const x = allocation('x#DELIVERY', 0n);
    const y = allocation('y#DELIVERY', 0n);
    const result = reconcileCharges({
      allocations: [x, y],
      estimated: [],
      rows: [row({ brokerage: 3n })],
      coverage: FY,
    });
    expect(result.reported.map((entry) => entry.amountMicro)).toEqual([2n, 1n]);
  });

  it('ignores DP estimates: a separate statement bills them', () => {
    const result = reconcileCharges({
      allocations: [SELL],
      estimated: [estimate(SELL, 'dp', 15n * RUPEE)],
      rows: [row({})],
      coverage: FY,
    });
    expect(result.reported).toEqual([]);
    expect(result.status.get(SELL.allocationKey)).toBe('reconciled');
  });

  it('leaves trades outside the statement period estimated', () => {
    const later = allocation('f#DELIVERY', RUPEE, { dateIst: '2025-06-02' });
    const result = reconcileCharges({
      allocations: [later],
      estimated: [estimate(later, 'brokerage', RUPEE)],
      rows: [],
      coverage: FY,
    });
    expect(result.status.get(later.allocationKey)).toBe('estimated');
    expect(result.reported).toEqual([]);
  });

  it('a covered trade with no statement row keeps its estimate and is a discrepancy; the stray row is reported', () => {
    const other = allocation('f#DELIVERY', RUPEE, { instrumentKey: 'INE9' });
    const stray = row({ brokerage: 20n * RUPEE });
    const result = reconcileCharges({
      allocations: [other],
      estimated: [estimate(other, 'brokerage', 20n * RUPEE)],
      rows: [stray],
      coverage: FY,
    });
    expect(result.status.get(other.allocationKey)).toBe('discrepancy');
    expect(result.reported).toEqual([]);
    expect(result.discrepancies).toEqual([
      {
        scope: 'missing',
        dateIst: DAY,
        exchange: 'NSE',
        instrumentKey: 'INE9',
        component: 'brokerage',
        estimatedMicro: 20n * RUPEE,
        reportedMicro: 0n,
      },
    ]);
    expect(result.unmatchedRows).toEqual([stray]);
  });

  it('an unresolved row is unmatched; a covered trade with nothing estimated or billed reconciles', () => {
    const unresolved = row({ brokerage: RUPEE }, { instrumentKey: null });
    const quiet = allocation('q#DELIVERY', RUPEE, { dateIst: '2024-05-03' });
    const result = reconcileCharges({
      allocations: [quiet],
      estimated: [],
      rows: [unresolved],
      coverage: FY,
    });
    expect(result.unmatchedRows).toEqual([unresolved]);
    expect(result.status.get(quiet.allocationKey)).toBe('reconciled');
  });

  it('keeps instruments apart whatever their names contain', () => {
    const odd = allocation('o#DELIVERY', RUPEE, { instrumentKey: 'local:dhan:A|B,"C"' });
    const result = reconcileCharges({
      allocations: [odd],
      estimated: [estimate(odd, 'brokerage', RUPEE)],
      rows: [row({ brokerage: 2n * RUPEE }, { instrumentKey: 'local:dhan:A|B,"C"' })],
      coverage: FY,
    });
    expect(result.discrepancies.map((entry) => entry.instrumentKey)).toEqual(['local:dhan:A|B,"C"']);
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
