import { InvalidArgumentError } from '../errors.js';

/**
 * Splits `total` across `items` in proportion to their weights, so the parts always sum to `total` exactly.
 * Each part gets the floor of its exact share; the leftover units go to the largest remainders, ties broken by
 * lower index (deterministic). Returns each item with its part.
 */
export function splitByWeight<T>(
  total: bigint,
  items: readonly T[],
  weightOf: (item: T) => bigint,
): { readonly item: T; readonly part: bigint }[] {
  const weights = items.map(weightOf);
  if (weights.some((weight) => weight < 0n)) throw new InvalidArgumentError('weights cannot be negative');
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0n);
  if (weightSum === 0n) {
    if (total !== 0n) throw new InvalidArgumentError('cannot allocate a non-zero total over zero weight');
    return items.map((item) => ({ item, part: 0n }));
  }

  const magnitude = total < 0n ? -total : total;
  const shares = items.map((item, index) => {
    const weight = weightOf(item);
    return {
      item,
      index,
      floor: (magnitude * weight) / weightSum,
      remainder: (magnitude * weight) % weightSum,
    };
  });
  const leftover = magnitude - shares.reduce((sum, share) => sum + share.floor, 0n);
  const bonusIndexes = new Set(
    [...shares]
      .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1))
      .filter((_, rank) => BigInt(rank) < leftover)
      .map((share) => share.index),
  );

  return shares.map((share) => {
    const part = share.floor + (bonusIndexes.has(share.index) ? 1n : 0n);
    return { item: share.item, part: total < 0n ? -part : part };
  });
}

/**
 * Splits `total` across `weights` in proportion (see splitByWeight). Used to spread contract-note charges over
 * fills (ADR-0016) and fill values over buckets and lots (ADR-0012).
 */
export function allocateLargestRemainder(total: bigint, weights: readonly bigint[]): readonly bigint[] {
  return splitByWeight(total, weights, (weight) => weight).map(({ part }) => part);
}
