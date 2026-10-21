// Exact ratios for analytics (win rate, averages, profit factor, R): bigint numerator and denominator, reduced, the
// sign on the numerator. The UI turns them into decimals for display only.
import { InvalidArgumentError } from '../errors.js';

export interface Ratio {
  readonly num: bigint;
  /** > 0. */
  readonly den: bigint;
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [abs(a), abs(b)];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function ratio(num: bigint, den: bigint): Ratio {
  if (den === 0n) throw new InvalidArgumentError('a ratio cannot have a zero denominator');
  const sign = den < 0n ? -1n : 1n;
  // den ≠ 0, so the divisor is at least 1.
  const divisor = gcd(num, den);
  return { num: (sign * num) / divisor, den: abs(den) / divisor };
}

/** The mean of exact ratios, exact. */
export function meanRatio(values: readonly Ratio[]): Ratio | null {
  if (values.length === 0) return null;
  const sum = values.reduce(
    (total, value) => ratio(total.num * value.den + value.num * total.den, total.den * value.den),
    ratio(0n, 1n),
  );
  return ratio(sum.num, sum.den * BigInt(values.length));
}
