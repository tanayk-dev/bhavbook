// Product buckets (ADR-0012, PRD §7.2-§7.3). Per (account, instrument, IST date): intraday = min(bought, sold),
// taken from each side's earliest fills in time order (a fill splits at the boundary). That quantity is INTRADAY
// for every broker and declared product. The remainder keeps its declared product (DELIVERY / MTF); Zerodha
// (no product column) and a Dhan INTRADAY remainder become DELIVERY. A product override re-buckets the whole day.
import { InvalidArgumentError } from '../errors.js';
import { splitByWeight } from '../money/allocate.js';
import {
  compareAllocations,
  compareFills,
  groupBy,
  type Bucket,
  type FillAllocation,
  type ProductOverride,
  type Side,
  type TradeFill,
} from './types.js';

function dayKey(value: { accountId: string; instrumentKey: string; tradeDateIst: string }): string {
  return `${value.accountId}\u0000${value.instrumentKey}\u0000${value.tradeDateIst}`;
}

function remainderBucket(fill: TradeFill): Bucket {
  return fill.productDeclared === 'MTF' ? 'MTF' : 'DELIVERY';
}

function allocation(
  fill: TradeFill,
  bucket: Bucket,
  quantity: bigint,
  valueMicro: bigint,
  inferred: boolean,
): FillAllocation {
  return {
    key: `${fill.id}#${bucket}`,
    fillId: fill.id,
    adjustmentId: null,
    accountId: fill.accountId,
    instrumentKey: fill.instrumentKey,
    bucket,
    side: fill.side,
    quantity,
    valueMicro,
    inferred,
    executedAtUtc: fill.executedAtUtc,
    tradeDateIst: fill.tradeDateIst,
    dedupKey: fill.dedupKey,
  };
}

/** Splits one fill into its intraday part and its remainder, values split exactly by quantity. */
function splitFill(fill: TradeFill, intraday: bigint, inferred: boolean): FillAllocation[] {
  const rest = fill.quantity - intraday;
  const parts: { bucket: Bucket; quantity: bigint }[] = [];
  if (intraday > 0n) parts.push({ bucket: 'INTRADAY', quantity: intraday });
  if (rest > 0n) parts.push({ bucket: remainderBucket(fill), quantity: rest });
  return splitByWeight(fill.valueMicro, parts, (entry) => entry.quantity).map(({ item, part }) =>
    allocation(fill, item.bucket, item.quantity, part, inferred),
  );
}

function netDay(fills: readonly TradeFill[], overridden: boolean): FillAllocation[] {
  const total = (side: Side): bigint =>
    fills.filter((fill) => fill.side === side).reduce((sum, fill) => sum + fill.quantity, 0n);
  const bought = total('BUY');
  const sold = total('SELL');
  const left: Record<Side, bigint> = {
    BUY: bought < sold ? bought : sold,
    SELL: bought < sold ? bought : sold,
  };
  return fills.flatMap((fill) => {
    const intraday = left[fill.side] < fill.quantity ? left[fill.side] : fill.quantity;
    left[fill.side] -= intraday;
    return splitFill(fill, intraday, !overridden && fill.productDeclared === null);
  });
}

const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function validate(fills: readonly TradeFill[]): void {
  for (const fill of fills) {
    if (fill.quantity <= 0n) throw new InvalidArgumentError('fill quantity must be positive');
    if (fill.valueMicro < 0n) throw new InvalidArgumentError('fill value cannot be negative');
    if (!UTC_SECONDS.test(fill.executedAtUtc))
      throw new InvalidArgumentError('fill time must be YYYY-MM-DDTHH:MM:SSZ');
  }
}

function overrideIndex(overrides: readonly ProductOverride[]): Map<string, Bucket> {
  const index = new Map<string, Bucket>();
  for (const override of overrides) {
    const key = dayKey(override);
    if (index.has(key))
      throw new InvalidArgumentError('two product overrides for the same account, instrument and day');
    index.set(key, override.bucket);
  }
  return index;
}

/**
 * An override re-buckets a whole day. An INTRADAY override can only make intraday what can be intraday: on an
 * unbalanced day the netted quantity goes to INTRADAY and the rest follows the remainder rule (an intraday holding
 * never carries over a night), but nothing on that day counts as inferred.
 */
export function allocateBuckets(
  fills: readonly TradeFill[],
  overrides: readonly ProductOverride[],
): FillAllocation[] {
  validate(fills);
  const overridden = overrideIndex(overrides);
  const allocations = [...groupBy(fills, dayKey).entries()].flatMap(([key, group]) => {
    const ordered = [...group].sort(compareFills);
    const bucket = overridden.get(key);
    if (bucket === undefined) return netDay(ordered, false);
    if (bucket === 'INTRADAY') return netDay(ordered, true);
    return ordered.map((fill) => allocation(fill, bucket, fill.quantity, fill.valueMicro, false));
  });
  return allocations.sort(compareAllocations);
}
