// Builders for fee-engine tests.
import {
  allocateBuckets,
  bundledFeeRules,
  computeCharges,
  type Bucket,
  type ChargeableFill,
  type ChargeComponent,
  type FeeBroker,
  type FillCharge,
} from '../../src/index.js';
import { fill, type FillSpec } from '../fifo/helpers.js';

export const PAISA = 10_000n;

export function chargeable(spec: FillSpec & { readonly exchange?: 'NSE' | 'BSE' }): ChargeableFill {
  return { ...fill(spec), exchange: spec.exchange ?? 'NSE' };
}

export function charge(
  broker: FeeBroker,
  fills: readonly ChargeableFill[],
  overrides: readonly {
    accountId: string;
    instrumentKey: string;
    tradeDateIst: string;
    bucket: Bucket;
  }[] = [],
) {
  const allocations = allocateBuckets(fills, overrides);
  return { allocations, ...computeCharges({ broker, fills, allocations, rules: bundledFeeRules() }) };
}

/** Total of one component (all allocations, or those of one fill). */
export function total(charges: readonly FillCharge[], component: ChargeComponent, fillId?: string): bigint {
  return charges
    .filter(
      (entry) =>
        entry.component === component &&
        (fillId === undefined || entry.allocationKey.startsWith(`${fillId}#`)),
    )
    .reduce((sum, entry) => sum + entry.amountMicro, 0n);
}
