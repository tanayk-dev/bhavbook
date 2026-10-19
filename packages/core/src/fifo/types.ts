// Reconstruction types (PRD §7.1). Money is bigint micro-rupees; times are UTC ISO strings and IST dates.

export type Bucket = 'DELIVERY' | 'INTRADAY' | 'MTF';
export type Side = 'BUY' | 'SELL';

/** One imported trade row, already keyed to an instrument (ISIN or broker-local id). */
export interface TradeFill {
  /** Stable within one recompute (e.g. the trade_row id). */
  readonly id: string;
  readonly accountId: string;
  readonly instrumentKey: string;
  /** Stable across re-imports; orders ties and anchors positions. */
  readonly dedupKey: string;
  /** `YYYY-MM-DDTHH:MM:SSZ` exactly (whole seconds, as the adapters emit), so string order is time order. */
  readonly executedAtUtc: string;
  readonly tradeDateIst: string;
  readonly side: Side;
  /** > 0. */
  readonly quantity: bigint;
  /** trade_value_micro: the broker's value, never qty x price (ADR-0008). */
  readonly valueMicro: bigint;
  /** Dhan declares a product; Zerodha does not (null). */
  readonly productDeclared: Bucket | null;
  readonly granularity: 'fill' | 'order';
  readonly externalOrderId: string | null;
}

/** A user's `product_override` adjustment (S10a): re-buckets a whole (account, instrument, IST date). */
export interface ProductOverride {
  readonly accountId: string;
  readonly instrumentKey: string;
  readonly tradeDateIst: string;
  readonly bucket: Bucket;
}

/** The part of a fill that lands in one bucket. A fill splits into at most two (intraday + remainder). */
export interface FillAllocation {
  /** `<fill id>#<bucket>`: unique per allocation. */
  readonly key: string;
  readonly fillId: string;
  /** The opening-lot adjustment behind a synthetic allocation; null for imported fills. */
  readonly adjustmentId: string | null;
  /** The corporate action that created or reshaped this allocation (bonus and demerger-child lots); else null. */
  readonly corporateActionId: string | null;
  readonly accountId: string;
  readonly instrumentKey: string;
  readonly bucket: Bucket;
  readonly side: Side;
  readonly quantity: bigint;
  readonly valueMicro: bigint;
  /**
   * HAS_INFERRED_PRODUCT (PRD §7.2, plan S9): the broker declared no product (Zerodha), so the bucket is inferred
   * by the netting rule. Dhan fills keep their declared product visible instead; an override is never inferred.
   */
  readonly inferred: boolean;
  readonly executedAtUtc: string;
  readonly tradeDateIst: string;
  readonly dedupKey: string;
}

/** A matched (or still open) quantity: entry is always the buy, exit the sell (intraday shorts included). */
export interface Lot {
  readonly accountId: string;
  readonly instrumentKey: string;
  readonly bucket: Bucket;
  readonly entry: string;
  readonly exit: string | null;
  readonly quantity: bigint;
  readonly entryValueMicro: bigint;
  readonly exitValueMicro: bigint | null;
  readonly entryDateIst: string;
  readonly exitDateIst: string | null;
}

/** Sold quantity with nothing held to match it (PRD §3.2 invariant 5: never an invented buy). */
export interface Orphan {
  readonly allocation: string;
  readonly accountId: string;
  readonly instrumentKey: string;
  readonly bucket: Bucket;
  readonly quantity: bigint;
  readonly valueMicro: bigint;
  readonly atUtc: string;
  readonly dateIst: string;
}

export interface MatchResult {
  readonly lots: readonly Lot[];
  readonly orphans: readonly Orphan[];
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The one ordering rule (PRD §7.1): executed_at, then dedup_key. */
export function compareFills(
  a: { readonly executedAtUtc: string; readonly dedupKey: string },
  b: { readonly executedAtUtc: string; readonly dedupKey: string },
): number {
  return byText(a.executedAtUtc, b.executedAtUtc) || byText(a.dedupKey, b.dedupKey);
}

/** Within one fill, the intraday part comes before the remainder. */
const PART_RANK: Readonly<Record<Bucket, number>> = { INTRADAY: 0, DELIVERY: 1, MTF: 1 };

/** A total order on allocations: execution order, then account and fill (dedup keys can repeat across accounts), then key. */
export function compareAllocations(a: FillAllocation, b: FillAllocation): number {
  return (
    compareFills(a, b) ||
    byText(a.accountId, b.accountId) ||
    byText(a.fillId, b.fillId) ||
    PART_RANK[a.bucket] - PART_RANK[b.bucket] ||
    // A part already sold before a corporate action, then the part it reshaped (`<key>~<action>`).
    byText(a.key, b.key)
  );
}

export function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return groups;
}

/** Map entries in key order, so every output is independent of input order. */
export function sortedEntries<T>(groups: Map<string, T>): [string, T][] {
  return [...groups.entries()].sort(([a], [b]) => byText(a, b));
}
