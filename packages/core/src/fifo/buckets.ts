// Product buckets (ADR-0012, PRD §7.2-§7.3). Per (account, instrument, IST date): intraday = min(bought, sold),
// taken from each side's earliest fills in time order (a fill splits at the boundary). That quantity is INTRADAY
// for every broker and declared product. The remainder keeps its declared product (DELIVERY / MTF); Zerodha
// (no product column) and a Dhan INTRADAY remainder become DELIVERY. A product override re-buckets the whole day.
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
function splitFill(fill: TradeFill, intraday: bigint): FillAllocation[] {
  const rest = fill.quantity - intraday;
  const parts: { bucket: Bucket; quantity: bigint }[] = [];
  if (intraday > 0n) parts.push({ bucket: 'INTRADAY', quantity: intraday });
  if (rest > 0n) parts.push({ bucket: remainderBucket(fill), quantity: rest });
  const inferred = fill.productDeclared === null;
  return splitByWeight(fill.valueMicro, parts, (entry) => entry.quantity).map(({ item, part }) =>
    allocation(fill, item.bucket, item.quantity, part, inferred),
  );
}

function netDay(fills: readonly TradeFill[]): FillAllocation[] {
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
    return splitFill(fill, intraday);
  });
}

export function allocateBuckets(
  fills: readonly TradeFill[],
  overrides: readonly ProductOverride[],
): FillAllocation[] {
  const overridden = new Map(overrides.map((override) => [dayKey(override), override.bucket]));
  const allocations = [...groupBy(fills, dayKey).entries()].flatMap(([key, group]) => {
    const ordered = [...group].sort(compareFills);
    const bucket = overridden.get(key);
    if (bucket !== undefined) {
      return ordered.map((fill) => allocation(fill, bucket, fill.quantity, fill.valueMicro, false));
    }
    return netDay(ordered);
  });
  return allocations.sort(compareAllocations);
}
