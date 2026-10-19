// Reconstruction with adjustments (plan S10a task 1): opening lots become synthetic entry allocations (never
// netted: they are holdings, not trades), exclusions mark positions, and product overrides re-bucket days.
import { InvalidArgumentError } from '../errors.js';
import { allocateBuckets } from '../fifo/buckets.js';
import { matchFifo } from '../fifo/match.js';
import {
  compareAllocations,
  type FillAllocation,
  type ProductOverride,
  type TradeFill,
} from '../fifo/types.js';
import { buildPositions, type Position } from '../positions/build.js';
import { istDateOf, istDayBounds } from '../time/ist.js';
import type { Adjustment, OpeningLot } from './types.js';

const SECOND_MS = 1_000;

function dayStart(date: string): string {
  try {
    return istDayBounds(date).startUtc;
  } catch (error) {
    throw new InvalidArgumentError('an opening lot date must be a real YYYY-MM-DD date', { cause: error });
  }
}

/** When an opening lot sits on the timeline: the start of its entry day, or one second before the "before" day. */
function placement(lot: OpeningLot): { executedAtUtc: string; tradeDateIst: string } {
  const { entryDateIst, beforeDateIst } = lot;
  if (entryDateIst !== undefined && beforeDateIst === undefined) {
    return { executedAtUtc: dayStart(entryDateIst), tradeDateIst: entryDateIst };
  }
  if (beforeDateIst !== undefined && entryDateIst === undefined) {
    const justBefore = `${new Date(Date.parse(dayStart(beforeDateIst)) - SECOND_MS).toISOString().slice(0, 19)}Z`;
    return { executedAtUtc: justBefore, tradeDateIst: istDateOf(justBefore) };
  }
  throw new InvalidArgumentError('an opening lot needs exactly one of entry date or before date');
}

function openingAllocation(lot: OpeningLot): FillAllocation {
  if ((lot.bucket as string) === 'INTRADAY')
    throw new InvalidArgumentError('an opening lot is a holding (DELIVERY or MTF)');
  if (lot.quantity <= 0n) throw new InvalidArgumentError('an opening lot quantity must be positive');
  if (lot.totalCostMicro < 0n) throw new InvalidArgumentError('an opening lot cost cannot be negative');
  const { executedAtUtc, tradeDateIst } = placement(lot);
  const id = `adj:${lot.id}`;
  return {
    key: `${id}#${lot.bucket}`,
    fillId: id,
    adjustmentId: lot.id,
    accountId: lot.accountId,
    instrumentKey: lot.instrumentKey,
    bucket: lot.bucket,
    side: 'BUY',
    quantity: lot.quantity,
    valueMicro: lot.totalCostMicro,
    inferred: false,
    executedAtUtc,
    tradeDateIst,
    dedupKey: id,
  };
}

export interface Reconstruction {
  readonly allocations: readonly FillAllocation[];
  readonly positions: readonly Position[];
}

/** The account's positions from its fills and active adjustments. Pure and deterministic. */
export function reconstructAccount(
  fills: readonly TradeFill[],
  adjustments: readonly Adjustment[],
): Reconstruction {
  const overrides: ProductOverride[] = [];
  const opening: FillAllocation[] = [];
  const excluded = new Set<string>();
  for (const adjustment of adjustments) {
    if (adjustment.kind === 'opening_lot') opening.push(openingAllocation(adjustment));
    else if (adjustment.kind === 'exclude')
      excluded.add(`${adjustment.accountId}\u0000${adjustment.anchorKey}`);
    else overrides.push(adjustment);
  }
  const allocations = [...allocateBuckets(fills, overrides), ...opening].sort(compareAllocations);
  const positions = buildPositions(allocations, matchFifo(allocations)).map((position) =>
    excluded.has(`${position.accountId}\u0000${position.anchorKey}`)
      ? { ...position, excluded: true }
      : position,
  );
  return { allocations, positions };
}

function orphanQuantity(reconstruction: Reconstruction, key: string): bigint {
  return reconstruction.positions
    .filter((position) => `${position.accountId}|${position.instrumentKey}|${position.bucket}` === key)
    .reduce((sum, position) => sum + position.orphanQty, 0n);
}

/**
 * Opening lots that real fills now cover, wholly or partly (E7): leaving the lot out no longer adds orphan
 * quantity equal to the lot. Only a suggestion: replacing a lot is always the user's decision.
 */
export function redundantOpeningLots(
  fills: readonly TradeFill[],
  adjustments: readonly Adjustment[],
): string[] {
  const withAll = reconstructAccount(fills, adjustments);
  return adjustments.flatMap((adjustment) => {
    if (adjustment.kind !== 'opening_lot') return [];
    const without = reconstructAccount(
      fills,
      adjustments.filter((other) => other.id !== adjustment.id),
    );
    const key = `${adjustment.accountId}|${adjustment.instrumentKey}|${adjustment.bucket}`;
    const covered = orphanQuantity(without, key) - orphanQuantity(withAll, key);
    return covered < adjustment.quantity ? [adjustment.id] : [];
  });
}
