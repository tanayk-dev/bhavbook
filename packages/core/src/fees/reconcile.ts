// Reconciliation (S12b, ADR-0017, PRD §8.2): the broker's statement against the engine's estimates. Wherever a
// statement covers a trade date, the charges it reports replace the estimates for that (date, exchange, instrument)
// group. Each component's billed amount is split in proportion to that component's estimates, so the engine's shape
// is kept (STT on the sells, a corporate action's demerged part, shares cashed out by one), with exact sums; a
// component the engine did not estimate is split by allocation value. Tolerances: ±₹0.01 per component per statement
// row; STT and stamp duty per contract note (date, exchange) against the billed total rounded to the rupee, since a
// statement's per-scrip rows split a rupee-rounded total. Outside tolerance the allocations are a discrepancy, and
// the reported value is still the one used. DP charges come from a separate statement and stay estimated here.
import { roundMicro } from '../money/decimal.js';
import { splitByWeight } from '../money/allocate.js';
import type { ChargeComponent } from './charges.js';

export type ReconciledComponent = Exclude<ChargeComponent, 'dp'>;

/** In the engine's order. */
const COMPONENTS: readonly ReconciledComponent[] = [
  'brokerage',
  'stt',
  'exchange_txn',
  'sebi',
  'ipft',
  'stamp_duty',
  'gst',
];
const CONTRACT_NOTE_LEVEL: readonly ReconciledComponent[] = ['stt', 'stamp_duty'];
const PAISA = 10_000n;

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

/** Where a charge was billed: the imported trade's IST date, exchange and instrument (before corporate actions). */
export interface ChargePlace {
  readonly dateIst: string;
  readonly exchange: string;
  readonly instrumentKey: string;
}

/** An allocation of an imported trade (or a part a corporate action made of one), placed by that trade. */
export interface ChargedAllocation extends ChargePlace {
  readonly allocationKey: string;
  readonly valueMicro: bigint;
}

export interface EstimatedCharge extends ChargePlace {
  /** Null: the share of shares a corporate action cashed out, which no allocation holds. */
  readonly allocationKey: string | null;
  readonly component: ChargeComponent;
  readonly amountMicro: bigint;
}

/** One statement row: what the broker billed for a (date, exchange, scrip), per component. */
export interface StatementChargeRow {
  readonly dateIst: string;
  readonly exchange: string;
  /** The resolved instrument, or null when the statement's scrip could not be resolved. */
  readonly instrumentKey: string | null;
  readonly amounts: Readonly<Partial<Record<ReconciledComponent, bigint>>>;
}

export interface ReportedCharge {
  readonly allocationKey: string;
  readonly component: ReconciledComponent;
  readonly amountMicro: bigint;
}

export interface ChargeDiscrepancy {
  /** `row`: a group beyond tolerance; `note`: STT or stamp duty for a contract note; `missing`: no row at all. */
  readonly scope: 'row' | 'note' | 'missing';
  readonly dateIst: string;
  readonly exchange: string;
  /** Null for a contract-note comparison. */
  readonly instrumentKey: string | null;
  readonly component: ReconciledComponent;
  readonly estimatedMicro: bigint;
  readonly reportedMicro: bigint;
}

export type AllocationChargeStatus = 'estimated' | 'reconciled' | 'discrepancy';

export interface ReconcileInput {
  readonly allocations: readonly ChargedAllocation[];
  readonly estimated: readonly EstimatedCharge[];
  readonly rows: readonly StatementChargeRow[];
  /** The dates the imported statements cover. */
  readonly coverage: readonly DateRange[];
}

export interface ReconcileResult {
  readonly reported: readonly ReportedCharge[];
  /** Reported amounts that went with shares a corporate action cashed out (no allocation holds them). */
  readonly reportedUnattachedMicro: bigint;
  readonly status: ReadonlyMap<string, AllocationChargeStatus>;
  readonly discrepancies: readonly ChargeDiscrepancy[];
  /** Rows for a scrip with no trade on that date and exchange, or one that could not be resolved. */
  readonly unmatchedRows: readonly StatementChargeRow[];
}

interface Group {
  readonly place: ChargePlace;
  readonly allocations: readonly ChargedAllocation[];
  readonly estimates: readonly EstimatedCharge[];
  readonly rows: readonly StatementChargeRow[];
}

interface Share {
  /** Null: the cashed-out share. */
  readonly allocationKey: string | null;
  readonly part: bigint;
}

const inRange = (date: string, ranges: readonly DateRange[]): boolean =>
  ranges.some((range) => date >= range.from && date <= range.to);
/** Structured keys (JSON), so a scrip name containing any separator can't collide or be cut. */
const placeKey = (place: ChargePlace): string =>
  JSON.stringify([place.dateIst, place.exchange, place.instrumentKey]);
const noteKey = (place: ChargePlace): string => JSON.stringify([place.dateIst, place.exchange]);
const abs = (value: bigint): bigint => (value < 0n ? -value : value);
/** Map entries in key order; keys are unique, so two never compare equal. */
const byKey = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]): number => (a < b ? -1 : 1);

function estimatedTotal(group: Group, component: ReconciledComponent): bigint {
  return group.estimates.reduce(
    (sum, charge) => sum + (charge.component === component ? charge.amountMicro : 0n),
    0n,
  );
}

function billedTotal(rows: readonly StatementChargeRow[], component: ReconciledComponent): bigint {
  return rows.reduce((sum, row) => sum + (row.amounts[component] ?? 0n), 0n);
}

/** Covered allocations and estimates by place, with the statement rows of each place; the rest is unmatched. */
function buildGroups(input: ReconcileInput): {
  groups: ReadonlyMap<string, Group>;
  uncovered: readonly string[];
  unmatchedRows: readonly StatementChargeRow[];
} {
  // Built in one pass over each input; the arrays are private until returned as readonly groups.
  const groups = new Map<
    string,
    {
      place: ChargePlace;
      allocations: ChargedAllocation[];
      estimates: EstimatedCharge[];
      rows: StatementChargeRow[];
    }
  >();
  const groupOf = (place: ChargePlace) => {
    const key = placeKey(place);
    const group = groups.get(key) ?? {
      place: { dateIst: place.dateIst, exchange: place.exchange, instrumentKey: place.instrumentKey },
      allocations: [],
      estimates: [],
      rows: [],
    };
    groups.set(key, group);
    return group;
  };
  const uncovered: string[] = [];
  for (const allocation of input.allocations) {
    if (inRange(allocation.dateIst, input.coverage)) groupOf(allocation).allocations.push(allocation);
    else uncovered.push(allocation.allocationKey);
  }
  for (const charge of input.estimated) {
    if (charge.component !== 'dp' && inRange(charge.dateIst, input.coverage))
      groupOf(charge).estimates.push(charge);
  }
  const unmatchedRows: StatementChargeRow[] = [];
  for (const row of input.rows) {
    const group =
      row.instrumentKey === null
        ? undefined
        : groups.get(placeKey({ ...row, instrumentKey: row.instrumentKey }));
    if (group === undefined) unmatchedRows.push(row);
    else group.rows.push(row);
  }
  return { groups, uncovered, unmatchedRows };
}

/**
 * Splits one component's billed amount over the group: by that component's estimates when there are any (a share
 * with no allocation stays unattached), otherwise by allocation value (evenly when none has a value).
 */
function distribute(group: Group, component: ReconciledComponent, billed: bigint): Share[] {
  const estimates = group.estimates.filter(
    (charge) => charge.component === component && charge.amountMicro > 0n,
  );
  if (estimates.length > 0) {
    return splitByWeight(billed, estimates, (charge) => charge.amountMicro).map(({ item, part }): Share => ({
      allocationKey: item.allocationKey,
      part,
    }));
  }
  const valued = group.allocations.some((allocation) => allocation.valueMicro > 0n);
  return splitByWeight(billed, group.allocations, (allocation) => (valued ? allocation.valueMicro : 1n)).map(
    ({ item, part }): Share => ({ allocationKey: item.allocationKey, part }),
  );
}

/** Reported charges of a group with rows, per allocation and component (estimates of one allocation summed). */
function reportGroup(group: Group): { reported: ReportedCharge[]; unattached: bigint } {
  const reported: ReportedCharge[] = [];
  let unattached = 0n;
  for (const component of COMPONENTS) {
    const billed = billedTotal(group.rows, component);
    if (billed === 0n && estimatedTotal(group, component) === 0n) continue;
    const parts = new Map<string, bigint>();
    for (const { allocationKey, part } of distribute(group, component, billed)) {
      if (allocationKey === null) unattached += part;
      else parts.set(allocationKey, (parts.get(allocationKey) ?? 0n) + part);
    }
    for (const [allocationKey, amountMicro] of parts)
      reported.push({ allocationKey, component, amountMicro });
  }
  return { reported, unattached };
}

/** Components of a group with rows beyond ±₹0.01 per row (contract-note components are compared per note). */
function rowDiscrepancies(group: Group): ChargeDiscrepancy[] {
  const tolerance = BigInt(group.rows.length) * PAISA;
  return COMPONENTS.flatMap((component) => {
    if (CONTRACT_NOTE_LEVEL.includes(component)) return [];
    const estimatedMicro = estimatedTotal(group, component);
    const reportedMicro = billedTotal(group.rows, component);
    if (abs(estimatedMicro - reportedMicro) <= tolerance) return [];
    return [{ scope: 'row' as const, ...group.place, component, estimatedMicro, reportedMicro }];
  });
}

/** A group with no statement row: every component the engine estimated is missing from the statement. */
function missingDiscrepancies(group: Group): ChargeDiscrepancy[] {
  return COMPONENTS.flatMap((component) => {
    const estimatedMicro = estimatedTotal(group, component);
    if (estimatedMicro === 0n) return [];
    return [{ scope: 'missing' as const, ...group.place, component, estimatedMicro, reportedMicro: 0n }];
  });
}

/** STT and stamp duty of one contract note: the engine's total against the billed total rounded to the rupee. */
function noteDiscrepancies(groups: readonly [Group, ...Group[]]): ChargeDiscrepancy[] {
  const { dateIst, exchange } = groups[0].place;
  return CONTRACT_NOTE_LEVEL.flatMap((component) => {
    const estimatedMicro = groups.reduce((sum, group) => sum + estimatedTotal(group, component), 0n);
    const reportedMicro = groups.reduce((sum, group) => sum + billedTotal(group.rows, component), 0n);
    if (estimatedMicro === roundMicro(reportedMicro, 'rupee', 'half-up')) return [];
    return [
      {
        scope: 'note' as const,
        dateIst,
        exchange,
        instrumentKey: null,
        component,
        estimatedMicro,
        reportedMicro,
      },
    ];
  });
}

export function reconcileCharges(input: ReconcileInput): ReconcileResult {
  const { groups, uncovered, unmatchedRows } = buildGroups(input);
  const status = new Map<string, AllocationChargeStatus>(uncovered.map((key) => [key, 'estimated']));
  const reported: ReportedCharge[] = [];
  const discrepancies: ChargeDiscrepancy[] = [];
  const notes = new Map<string, [Group, ...Group[]]>();
  let reportedUnattachedMicro = 0n;
  for (const [, group] of [...groups].sort(byKey)) {
    const found = group.rows.length === 0 ? missingDiscrepancies(group) : rowDiscrepancies(group);
    discrepancies.push(...found);
    for (const allocation of group.allocations) {
      status.set(allocation.allocationKey, found.length > 0 ? 'discrepancy' : 'reconciled');
    }
    if (group.rows.length === 0) continue;
    const result = reportGroup(group);
    reported.push(...result.reported);
    reportedUnattachedMicro += result.unattached;
    const note = noteKey(group.place);
    notes.set(note, [...(notes.get(note) ?? []), group] as [Group, ...Group[]]);
  }
  for (const [, noteGroups] of [...notes].sort(byKey)) {
    const found = noteDiscrepancies(noteGroups);
    discrepancies.push(...found);
    if (found.length === 0) continue;
    for (const allocation of noteGroups.flatMap((group) => group.allocations)) {
      status.set(allocation.allocationKey, 'discrepancy');
    }
  }
  return { reported, reportedUnattachedMicro, status, discrepancies, unmatchedRows };
}

export type PositionChargeStatus = 'FEES_ESTIMATED' | 'FEES_RECONCILED' | 'FEES_DISCREPANCY';

/** A position's status from its allocations: any discrepancy, then any estimate; nothing charged is estimated. */
export function positionChargeStatus(
  allocationKeys: readonly string[],
  status: ReadonlyMap<string, AllocationChargeStatus>,
): PositionChargeStatus {
  const known = allocationKeys.flatMap((key) => {
    const value = status.get(key);
    return value === undefined ? [] : [value];
  });
  if (known.includes('discrepancy')) return 'FEES_DISCREPANCY';
  if (known.length === 0 || known.includes('estimated')) return 'FEES_ESTIMATED';
  return 'FEES_RECONCILED';
}

/** A closed lot, ours or a broker statement's (Dhan Tax Report, Zerodha Tax P&L). */
export interface LotFacts {
  readonly isin: string;
  readonly buyDateIst: string;
  readonly sellDateIst: string;
  readonly quantity: bigint;
  readonly buyValueMicro: bigint;
}

export interface LotMismatch {
  readonly isin: string;
  readonly buyDateIst: string;
  readonly sellDateIst: string;
  readonly ourQuantity: bigint;
  readonly statementQuantity: bigint;
  readonly ourValueMicro: bigint;
  readonly statementValueMicro: bigint;
}

/**
 * Per statement lot, how far the buy values may differ: the broker's reports disagree with its own trade file by a
 * few paise on some scrips (plan r7: up to ₹0.06), and the trade file's value is authoritative (ADR-0008).
 */
export const LOT_VALUE_TOLERANCE_MICRO = 10n * PAISA;

interface LotTotals {
  readonly quantity: bigint;
  readonly value: bigint;
  readonly lots: bigint;
}

const NO_LOTS: LotTotals = { quantity: 0n, value: 0n, lots: 0n };
const addLot = (totals: LotTotals, lot: LotFacts): LotTotals => ({
  quantity: totals.quantity + lot.quantity,
  value: totals.value + lot.buyValueMicro,
  lots: totals.lots + 1n,
});

/**
 * The FIFO cross-check (PRD §8.2): the statement's lots against ours, by ISIN and buy and sell date (split lots
 * summed on both sides). Our lots count only when sold inside the statement's period. Every difference in quantity,
 * or in value beyond tolerance, is a mismatch: a sign of missing history or a missed corporate action.
 */
export function crossCheckLots(
  ours: readonly LotFacts[],
  theirs: readonly LotFacts[],
  coverage: readonly DateRange[],
): LotMismatch[] {
  const sides = new Map<
    string,
    { readonly ours: LotTotals; readonly theirs: LotTotals; readonly lot: LotFacts }
  >();
  const add = (lot: LotFacts, side: 'ours' | 'theirs') => {
    const key = JSON.stringify([lot.isin, lot.buyDateIst, lot.sellDateIst]);
    const entry = sides.get(key) ?? { ours: NO_LOTS, theirs: NO_LOTS, lot };
    sides.set(key, { ...entry, [side]: addLot(entry[side], lot) });
  };
  for (const lot of ours) if (inRange(lot.sellDateIst, coverage)) add(lot, 'ours');
  for (const lot of theirs) add(lot, 'theirs');
  return [...sides].sort(byKey).flatMap(([, entry]) => {
    const tolerance = (entry.theirs.lots > 0n ? entry.theirs.lots : 1n) * LOT_VALUE_TOLERANCE_MICRO;
    const sameQuantity = entry.ours.quantity === entry.theirs.quantity;
    if (sameQuantity && abs(entry.ours.value - entry.theirs.value) <= tolerance) return [];
    const { isin, buyDateIst, sellDateIst } = entry.lot;
    return [
      {
        isin,
        buyDateIst,
        sellDateIst,
        ourQuantity: entry.ours.quantity,
        statementQuantity: entry.theirs.quantity,
        ourValueMicro: entry.ours.value,
        statementValueMicro: entry.theirs.value,
      },
    ];
  });
}
