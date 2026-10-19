// Reconstruction with adjustments (plan S10a task 1): opening lots become synthetic entry allocations (never
// netted: they are holdings, not trades), exclusions mark positions, and product overrides re-bucket days.
// Adjustments are stored data, so every field is checked at this boundary.
import { InvalidArgumentError } from '../errors.js';
import { allocateBuckets } from '../fifo/buckets.js';
import { matchFifo } from '../fifo/match.js';
import {
  compareAllocations,
  type Bucket,
  type FillAllocation,
  type ProductOverride,
  type TradeFill,
} from '../fifo/types.js';
import { applyCorporateActions } from '../corporate-actions/apply.js';
import type { CorporateAction, Fraction } from '../corporate-actions/types.js';
import { buildPositions, type Position } from '../positions/build.js';
import { istDateOf, istDayBounds } from '../time/ist.js';
import type { Adjustment, OpeningLot } from './types.js';

const SECOND_MS = 1_000;
const BUCKETS: ReadonlySet<string> = new Set<Bucket>(['DELIVERY', 'INTRADAY', 'MTF']);
const HOLDING_BUCKETS: ReadonlySet<string> = new Set<Bucket>(['DELIVERY', 'MTF']);

function dayStart(date: string): string {
  try {
    return istDayBounds(date).startUtc;
  } catch (error) {
    throw new InvalidArgumentError('an adjustment date must be a real YYYY-MM-DD date', { cause: error });
  }
}

/**
 * When an opening lot sits on the timeline: the start of its entry day, or one second before the "before" day.
 * A "before" lot's date is a lower bound (the shares were held at least since then), so a holding period
 * computed from it can only come out shorter than the real one.
 */
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
  // Runtime data (stored adjustments) may not respect the types.
  const bucket: unknown = lot.bucket;
  if (typeof bucket !== 'string' || !HOLDING_BUCKETS.has(bucket)) {
    throw new InvalidArgumentError('an opening lot is a holding (DELIVERY or MTF)');
  }
  if (typeof lot.quantity !== 'bigint' || lot.quantity <= 0n) {
    throw new InvalidArgumentError('an opening lot quantity must be a positive integer');
  }
  if (typeof lot.totalCostMicro !== 'bigint' || lot.totalCostMicro < 0n) {
    throw new InvalidArgumentError('an opening lot cost must be a non-negative amount');
  }
  const { executedAtUtc, tradeDateIst } = placement(lot);
  const id = `adj:${lot.id}`;
  return {
    key: `${id}#${lot.bucket}`,
    fillId: id,
    adjustmentId: lot.id,
    corporateActionId: null,
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

function checkOverride(override: ProductOverride): ProductOverride {
  const bucket: unknown = override.bucket;
  if (typeof bucket !== 'string' || !BUCKETS.has(bucket))
    throw new InvalidArgumentError('unknown product bucket');
  dayStart(override.tradeDateIst);
  return override;
}

export interface Reconstruction {
  readonly allocations: readonly FillAllocation[];
  readonly positions: readonly Position[];
  /** Entitlements to part of a share left by corporate actions (cash in lieu). */
  readonly fractions: readonly Fraction[];
}

interface Sorted {
  readonly overrides: ProductOverride[];
  readonly opening: FillAllocation[];
  readonly excluded: Set<string>;
}

function sortAdjustments(adjustments: readonly Adjustment[]): Sorted {
  const sorted: Sorted = { overrides: [], opening: [], excluded: new Set() };
  const ids = new Set<string>();
  for (const adjustment of adjustments) {
    if (ids.has(adjustment.id)) throw new InvalidArgumentError('two adjustments with the same id');
    ids.add(adjustment.id);
    switch (adjustment.kind) {
      case 'opening_lot':
        sorted.opening.push(openingAllocation(adjustment));
        break;
      case 'exclude':
        sorted.excluded.add(`${adjustment.accountId}\u0000${adjustment.anchorKey}`);
        break;
      case 'product_override':
        sorted.overrides.push(checkOverride(adjustment));
        break;
      default: {
        // Stored data can hold a kind this version doesn't know.
        const unknown: { readonly kind?: unknown } = adjustment;
        throw new InvalidArgumentError(`unknown adjustment kind: ${String(unknown.kind)}`);
      }
    }
  }
  return sorted;
}

/** Bucketed fills and opening lots, before corporate actions. */
export function baseAllocations(
  fills: readonly TradeFill[],
  adjustments: readonly Adjustment[],
): FillAllocation[] {
  const { overrides, opening } = sortAdjustments(adjustments);
  return [...allocateBuckets(fills, overrides), ...opening].sort(compareAllocations);
}

/**
 * The account's positions from its fills, active adjustments and corporate actions (applied in ex-date order to
 * what is open at each ex-date). Pure and deterministic.
 */
export function reconstructAccount(
  fills: readonly TradeFill[],
  adjustments: readonly Adjustment[],
  corporateActions: readonly CorporateAction[] = [],
): Reconstruction {
  const { excluded } = sortAdjustments(adjustments);
  const { allocations, fractions } = applyCorporateActions(
    baseAllocations(fills, adjustments),
    corporateActions,
  );
  const positions = buildPositions(allocations, matchFifo(allocations)).map((position) =>
    excluded.has(`${position.accountId}\u0000${position.anchorKey}`)
      ? { ...position, excluded: true }
      : position,
  );
  return { allocations, positions, fractions };
}

function orphanQuantity(reconstruction: Reconstruction, lot: OpeningLot): bigint {
  return reconstruction.positions
    .filter((position) => position.bucket === lot.bucket)
    .reduce((sum, position) => sum + position.orphanQty, 0n);
}

/**
 * Opening lots that real fills now cover (E7): the imported history reaches back before the lot (a real buy in
 * the same account, instrument and bucket precedes it), and leaving the lot out would no longer orphan the
 * quantity the lot was covering. A lot for shares still held, or only partly sold, with no earlier real buy is
 * never flagged. Suggestions only: replacing a lot is always the user's decision. Each lot is checked on its own
 * (account, instrument) slice, since netting and FIFO never cross instruments.
 */
export function redundantOpeningLots(
  fills: readonly TradeFill[],
  adjustments: readonly Adjustment[],
): string[] {
  return adjustments.flatMap((adjustment) => {
    if (adjustment.kind !== 'opening_lot') return [];
    const sameInstrument = (value: { accountId: string; instrumentKey: string }): boolean =>
      value.accountId === adjustment.accountId && value.instrumentKey === adjustment.instrumentKey;
    const slice = fills.filter(sameInstrument);
    const sliceAdjustments = adjustments.filter((other) => other.kind !== 'exclude' && sameInstrument(other));
    const withAll = reconstructAccount(slice, sliceAdjustments);
    const lotAllocation = withAll.allocations.find((allocation) => allocation.adjustmentId === adjustment.id);
    const realBuyBefore = withAll.allocations.some(
      (allocation) =>
        allocation.adjustmentId === null &&
        allocation.side === 'BUY' &&
        allocation.bucket === adjustment.bucket &&
        lotAllocation !== undefined &&
        allocation.executedAtUtc < lotAllocation.executedAtUtc,
    );
    if (!realBuyBefore) return [];
    const without = reconstructAccount(
      slice,
      sliceAdjustments.filter((other) => other.id !== adjustment.id),
    );
    const absorbed = orphanQuantity(without, adjustment) - orphanQuantity(withAll, adjustment);
    return absorbed < adjustment.quantity ? [adjustment.id] : [];
  });
}
