// What a corporate action would do, before it is stored (plan S10b task 2): the affected open lots before and
// after, and any fraction of a share left over.
import { baseAllocations } from '../adjustments/apply.js';
import type { Adjustment } from '../adjustments/types.js';
import type { Bucket, FillAllocation, TradeFill } from '../fifo/types.js';
import {
  applyCorporateAction,
  checkCorporateAction,
  openAt,
  openValueOf,
  orderCorporateActions,
  orderKey,
} from './apply.js';
import type { CorporateAction, Fraction } from './types.js';

export interface PreviewLot {
  readonly accountId: string;
  readonly instrumentKey: string;
  readonly bucket: Bucket;
  readonly quantity: bigint;
  readonly costMicro: bigint;
  readonly entryDateIst: string;
}

export interface CorporateActionPreview {
  readonly before: readonly PreviewLot[];
  readonly after: readonly PreviewLot[];
  readonly fractions: readonly Fraction[];
}

function lotOf(allocation: FillAllocation, quantity: bigint, costMicro: bigint): PreviewLot {
  return {
    accountId: allocation.accountId,
    instrumentKey: allocation.instrumentKey,
    bucket: allocation.bucket,
    quantity,
    costMicro,
    entryDateIst: allocation.tradeDateIst,
  };
}

/** Applies the actions that come before `action` (ex-date order), then shows what `action` changes. */
export function previewCorporateAction(
  fills: readonly TradeFill[],
  adjustments: readonly Adjustment[],
  action: CorporateAction,
  existing: readonly CorporateAction[] = [],
): CorporateActionPreview {
  const target = checkCorporateAction(action);
  let allocations = baseAllocations(fills, adjustments);
  for (const checked of orderCorporateActions(existing)) {
    if (orderKey(checked.action) < orderKey(action))
      allocations = applyCorporateAction(allocations, checked).allocations;
  }
  const before = openAt(allocations, target).map((member) =>
    lotOf(member.allocation, member.open, openValueOf(member)),
  );
  const result = applyCorporateAction(allocations, target);
  const after = result.allocations
    .filter(
      (allocation) => allocation.corporateActionId === action.id || allocation.key.endsWith(`~${action.id}`),
    )
    .map((allocation) => lotOf(allocation, allocation.quantity, allocation.valueMicro));
  return { before, after, fractions: result.fractions };
}
