// Exact ratios for analytics (win rate, averages, profit factor, R): bigint numerator and denominator, reduced, the
// sign on the numerator. formatRatio turns one into a decimal string for display, rounding half-up in bigint.
import { InvalidArgumentError } from '../errors.js';
import { divRound } from '../money/rounding.js';

export interface Ratio {
  readonly num: bigint;
  /** > 0. */
  readonly den: bigint;
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== 0n) {
    const rest = x % y;
    x = y;
    y = rest;
  }
  return x;
}

export function ratio(num: bigint, den: bigint): Ratio {
  if (den === 0n) throw new InvalidArgumentError('a ratio cannot have a zero denominator');
  // den ≠ 0, so the divisor is at least 1.
  const divisor = gcd(num, den);
  const sign = den < 0n ? -1n : 1n;
  return { num: (sign * num) / divisor, den: abs(den) / divisor };
}

/** A ratio as a decimal string with `places` decimals, rounded half-up (e.g. win rate 2/3 → "0.67"). */
export function formatRatio(value: Ratio, places: number): string {
  if (!Number.isInteger(places) || places < 0)
    throw new InvalidArgumentError('places must be a whole number');
  const scaled = divRound(value.num * 10n ** BigInt(places), value.den, 'half-up');
  const sign = scaled < 0n ? '-' : '';
  const digits = abs(scaled)
    .toString()
    .padStart(places + 1, '0');
  return places === 0 ? `${sign}${digits}` : `${sign}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}
