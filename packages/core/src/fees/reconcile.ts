// Reconciliation (S12b, ADR-0017, PRD §8.2): the broker's statement against the engine's estimates. Wherever a
// statement covers a trade date, the charges it reports replace the estimates for that (date, instrument): each
// component's billed amount is split over the group's allocations by value, with exact sums. Tolerances: ±₹0.01 per
// component per statement row; STT and stamp duty are compared per day against the day's billed total rounded to the
// rupee (a statement's per-scrip STT rows split a rupee-rounded contract-note total, so they drift by paise). Outside
// tolerance the allocations are a discrepancy, and the reported value is still the one used. DP charges come from a
// separate statement and are not reconciled here: they stay estimated.
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
const DAY_LEVEL: ReadonlySet<ReconciledComponent> = new Set(['stt', 'stamp_duty']);
const PAISA = 10_000n;

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

/** An allocation that carries charges, placed by the imported trade it came from. */
export interface ChargedAllocation {
  readonly allocationKey: string;
  /** The IST trade date of the imported fill. */
  readonly dateIst: string;
  /** The instrument of the imported fill (before any corporate action re-keyed it). */
  readonly instrumentKey: string;
  readonly valueMicro: bigint;
}

export interface EstimatedCharge {
  readonly allocationKey: string;
  readonly component: ChargeComponent;
  readonly amountMicro: bigint;
}

/** One statement row: what the broker billed for a (date, scrip), per component. */
export interface StatementChargeRow {
  readonly dateIst: string;
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
  /** `row`: a (date, instrument) beyond tolerance; `day`: STT or stamp duty for the day; `missing`: no row at all. */
  readonly scope: 'row' | 'day' | 'missing';
  readonly dateIst: string;
  /** Null for a day-level comparison. */
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
  readonly status: ReadonlyMap<string, AllocationChargeStatus>;
  readonly discrepancies: readonly ChargeDiscrepancy[];
  /** Rows for a scrip with no trade that day, or one that could not be resolved. */
  readonly unmatchedRows: readonly StatementChargeRow[];
}

const inRange = (date: string, ranges: readonly DateRange[]): boolean =>
  ranges.some((range) => date >= range.from && date <= range.to);
const groupKey = (dateIst: string, instrumentKey: string): string => `${dateIst}|${instrumentKey}`;
const abs = (value: bigint): bigint => (value < 0n ? -value : value);
/** Map entries in key order; keys are unique, so two never compare equal. */
const byKey = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]): number => (a < b ? -1 : 1);

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/** Estimates by allocation and component. */
function estimates(charges: readonly EstimatedCharge[]): Map<string, bigint> {
  const sums = new Map<string, bigint>();
  for (const charge of charges) {
    if (charge.component === 'dp') continue;
    const key = `${charge.allocationKey}|${charge.component}`;
    sums.set(key, (sums.get(key) ?? 0n) + charge.amountMicro);
  }
  return sums;
}

interface Group {
  readonly dateIst: string;
  readonly instrumentKey: string;
  readonly allocations: readonly ChargedAllocation[];
  readonly rows: readonly StatementChargeRow[];
}

/** Splits a billed amount over a group's allocations by value (evenly when none has a value). */
function split(total: bigint, allocations: readonly ChargedAllocation[]) {
  const valued = allocations.some((allocation) => allocation.valueMicro > 0n);
  return splitByWeight(total, allocations, (allocation) => (valued ? allocation.valueMicro : 1n));
}

interface Totals {
  readonly estimated: bigint;
  readonly reported: bigint;
}

/** Reported charges of one group, and its per-component totals. */
function reconcileGroup(group: Group, estimated: ReadonlyMap<string, bigint>) {
  const reported: ReportedCharge[] = [];
  const totals = new Map<ReconciledComponent, Totals>();
  for (const component of COMPONENTS) {
    const billed = group.rows.reduce((sum, row) => sum + (row.amounts[component] ?? 0n), 0n);
    const engine = group.allocations.reduce(
      (sum, allocation) => sum + (estimated.get(`${allocation.allocationKey}|${component}`) ?? 0n),
      0n,
    );
    totals.set(component, { estimated: engine, reported: billed });
    if (billed === 0n && engine === 0n) continue;
    for (const { item, part } of split(billed, group.allocations)) {
      reported.push({ allocationKey: item.allocationKey, component, amountMicro: part });
    }
  }
  return { reported, totals };
}

function missingDiscrepancies(group: Group, estimated: ReadonlyMap<string, bigint>): ChargeDiscrepancy[] {
  return COMPONENTS.flatMap((component) => {
    const engine = group.allocations.reduce(
      (sum, allocation) => sum + (estimated.get(`${allocation.allocationKey}|${component}`) ?? 0n),
      0n,
    );
    if (engine === 0n) return [];
    const { dateIst, instrumentKey } = group;
    return [
      {
        scope: 'missing' as const,
        dateIst,
        instrumentKey,
        component,
        estimatedMicro: engine,
        reportedMicro: 0n,
      },
    ];
  });
}

export function reconcileCharges(input: ReconcileInput): ReconcileResult {
  const estimated = estimates(input.estimated);
  const status = new Map<string, AllocationChargeStatus>();
  const groups = new Map<string, { allocations: ChargedAllocation[]; rows: StatementChargeRow[] }>();
  for (const allocation of input.allocations) {
    if (!inRange(allocation.dateIst, input.coverage)) {
      status.set(allocation.allocationKey, 'estimated');
      continue;
    }
    const key = groupKey(allocation.dateIst, allocation.instrumentKey);
    const group = groups.get(key) ?? { allocations: [], rows: [] };
    group.allocations.push(allocation);
    groups.set(key, group);
  }
  const unmatchedRows: StatementChargeRow[] = [];
  for (const row of input.rows) {
    const group =
      row.instrumentKey === null ? undefined : groups.get(groupKey(row.dateIst, row.instrumentKey));
    if (group === undefined) unmatchedRows.push(row);
    else group.rows.push(row);
  }

  const reported: ReportedCharge[] = [];
  const discrepancies: ChargeDiscrepancy[] = [];
  /** Day-level components, per date: the matched groups' totals, and the groups themselves. */
  const days = new Map<string, Group[]>();
  for (const [key, entry] of [...groups].sort(byKey)) {
    const [dateIst = '', instrumentKey = ''] = key.split('|');
    const group: Group = { dateIst, instrumentKey, ...entry };
    if (group.rows.length === 0) {
      const missing = missingDiscrepancies(group, estimated);
      discrepancies.push(...missing);
      for (const allocation of group.allocations) {
        status.set(allocation.allocationKey, missing.length > 0 ? 'discrepancy' : 'reconciled');
      }
      continue;
    }
    const result = reconcileGroup(group, estimated);
    reported.push(...result.reported);
    push(days, dateIst, group);
    const tolerance = BigInt(group.rows.length) * PAISA;
    let off = false;
    for (const [component, totals] of result.totals) {
      if (DAY_LEVEL.has(component) || abs(totals.estimated - totals.reported) <= tolerance) continue;
      off = true;
      discrepancies.push({
        scope: 'row',
        dateIst,
        instrumentKey,
        component,
        estimatedMicro: totals.estimated,
        reportedMicro: totals.reported,
      });
    }
    for (const allocation of group.allocations)
      status.set(allocation.allocationKey, off ? 'discrepancy' : 'reconciled');
  }
  for (const [dateIst, dayGroups] of days) {
    for (const component of DAY_LEVEL) {
      const engine = dayGroups.reduce(
        (sum, group) =>
          sum +
          group.allocations.reduce(
            (inner, allocation) => inner + (estimated.get(`${allocation.allocationKey}|${component}`) ?? 0n),
            0n,
          ),
        0n,
      );
      const billed = dayGroups.reduce(
        (sum, group) => sum + group.rows.reduce((inner, row) => inner + (row.amounts[component] ?? 0n), 0n),
        0n,
      );
      if (engine === roundMicro(billed, 'rupee', 'half-up')) continue;
      discrepancies.push({
        scope: 'day',
        dateIst,
        instrumentKey: null,
        component,
        estimatedMicro: engine,
        reportedMicro: billed,
      });
      for (const group of dayGroups) {
        for (const allocation of group.allocations) status.set(allocation.allocationKey, 'discrepancy');
      }
    }
  }
  return { reported, status, discrepancies, unmatchedRows };
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

interface Side {
  quantity: bigint;
  value: bigint;
  lots: bigint;
}

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
  const sides = new Map<string, { ours: Side; theirs: Side; lot: LotFacts }>();
  const add = (lot: LotFacts, which: 'ours' | 'theirs') => {
    const key = [lot.isin, lot.buyDateIst, lot.sellDateIst].join('|');
    const entry = sides.get(key) ?? {
      ours: { quantity: 0n, value: 0n, lots: 0n },
      theirs: { quantity: 0n, value: 0n, lots: 0n },
      lot,
    };
    entry[which].quantity += lot.quantity;
    entry[which].value += lot.buyValueMicro;
    entry[which].lots += 1n;
    sides.set(key, entry);
  };
  for (const lot of ours) if (inRange(lot.sellDateIst, coverage)) add(lot, 'ours');
  for (const lot of theirs) add(lot, 'theirs');
  return [...sides].sort(byKey).flatMap(([, { ours: our, theirs: their, lot }]) => {
    const tolerance = (their.lots > 0n ? their.lots : 1n) * LOT_VALUE_TOLERANCE_MICRO;
    if (our.quantity === their.quantity && abs(our.value - their.value) <= tolerance) return [];
    return [
      {
        isin: lot.isin,
        buyDateIst: lot.buyDateIst,
        sellDateIst: lot.sellDateIst,
        ourQuantity: our.quantity,
        statementQuantity: their.quantity,
        ourValueMicro: our.value,
        statementValueMicro: their.value,
      },
    ];
  });
}
