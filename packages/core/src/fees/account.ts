// An account's charges (plan S12a-2). Charges belong to the trades as imported, so they are computed on the
// bucketed fills (before corporate actions) and then carried onto the allocations a reconstruction ends with:
// a corporate action replaces an allocation `K` with parts keyed `K` (the part sold before it) and `K~<action>...`
// (the reshaped and demerged parts), and each charge of `K` is split over those parts by value, exactly.
// A charge whose allocation has no part left (a holding cashed out entirely) keeps its original key.
import { baseAllocations } from '../adjustments/apply.js';
import type { Adjustment } from '../adjustments/types.js';
import { groupBy, type FillAllocation } from '../fifo/types.js';
import { splitByWeight } from '../money/allocate.js';
import { computeCharges, type ChargeableFill, type ChargeResult, type FillCharge } from './charges.js';
import type { FeeBroker, FeeRules } from './rules.js';

export interface AccountChargeInput {
  readonly broker: FeeBroker;
  readonly fills: readonly ChargeableFill[];
  readonly adjustments: readonly Adjustment[];
  /** The allocations the account's reconstruction ended with (after corporate actions). */
  readonly allocations: readonly FillAllocation[];
  readonly rules: FeeRules;
}

/** The imported allocation a part came from: the key before the first `~`. */
function rootOf(key: string): string {
  const at = key.indexOf('~');
  return at < 0 ? key : key.slice(0, at);
}

function carry(charge: FillCharge, parts: readonly FillAllocation[] | undefined): FillCharge[] {
  if (parts === undefined) return [charge];
  return splitByWeight(charge.amountMicro, parts, (part) => part.valueMicro)
    .filter(({ part }) => part !== 0n)
    .map(({ item, part }) => ({ ...charge, allocationKey: item.key, amountMicro: part }));
}

export function chargeAccount(input: AccountChargeInput): ChargeResult {
  const { charges, unrated } = computeCharges({
    broker: input.broker,
    fills: input.fills,
    allocations: baseAllocations(input.fills, input.adjustments),
    rules: input.rules,
  });
  const parts = groupBy(input.allocations, (allocation) => rootOf(allocation.key));
  return { charges: charges.flatMap((charge) => carry(charge, parts.get(charge.allocationKey))), unrated };
}
