// An account's charges (plan S12a-2). Charges belong to the trades as imported, so they are computed on the
// bucketed fills (before corporate actions) and then carried onto the allocations a reconstruction ends with:
// a corporate action replaces an allocation `K` with parts keyed `K` (the part sold before it) and `K~<action>...`
// (the reshaped and demerged parts), and each charge of `K` is split over those parts by value, exactly.
// Corporate actions conserve cost except when shares are cashed out (a fraction of a holding, or all of it):
// the share of the charge that went with them has no allocation left and is returned as unattached, never dropped
// or loaded onto the shares that remain.
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

export interface AccountChargeResult extends ChargeResult {
  /** Charge shares of shares cashed out by a corporate action (keyed by the imported allocation). */
  readonly unattached: readonly FillCharge[];
}

interface Root {
  readonly valueMicro: bigint;
  readonly parts: FillAllocation[];
}

/** The imported allocation a part came from: the key before the first `~`. */
function rootOf(key: string): string {
  const at = key.indexOf('~');
  return at < 0 ? key : key.slice(0, at);
}

/** Splits a charge over the root's surviving parts and the value that left with cashed-out shares. */
function carry(charge: FillCharge, root: Root): { attached: FillCharge[]; unattached: FillCharge[] } {
  const surviving = root.parts.reduce((sum, part) => sum + part.valueMicro, 0n);
  const entries = [
    ...root.parts.map((part) => ({ key: part.key, weight: part.valueMicro })),
    { key: null, weight: root.valueMicro - surviving },
  ];
  const shares = splitByWeight(charge.amountMicro, entries, (entry) => entry.weight).filter(
    ({ part }) => part !== 0n,
  );
  return {
    attached: shares.flatMap(({ item, part }) =>
      item.key === null ? [] : [{ ...charge, allocationKey: item.key, amountMicro: part }],
    ),
    unattached: shares.flatMap(({ item, part }) =>
      item.key === null ? [{ ...charge, amountMicro: part }] : [],
    ),
  };
}

export function chargeAccount(input: AccountChargeInput): AccountChargeResult {
  const base = baseAllocations(input.fills, input.adjustments);
  const { charges, unrated } = computeCharges({
    broker: input.broker,
    fills: input.fills,
    allocations: base,
    rules: input.rules,
  });
  const roots = new Map<string, Root>(
    base.map((allocation) => [allocation.key, { valueMicro: allocation.valueMicro, parts: [] }]),
  );
  // Bonus lots have no imported allocation behind them and carry no charge.
  for (const allocation of input.allocations) roots.get(rootOf(allocation.key))?.parts.push(allocation);
  const byKey = groupBy(charges, (charge) => charge.allocationKey);
  const attached: FillCharge[] = [];
  const unattached: FillCharge[] = [];
  for (const [key, root] of roots) {
    for (const charge of byKey.get(key) ?? []) {
      const carried = carry(charge, root);
      attached.push(...carried.attached);
      unattached.push(...carried.unattached);
    }
  }
  return { charges: attached, unrated, unattached };
}
