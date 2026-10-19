// Rates as exact rationals (ADR-0004). Fee-rule JSON stores rates as decimal or percentage strings.
import { ParseError } from '../errors.js';
import { parseScaledDecimal, pow10 } from './decimal.js';
import { divRound, type RoundingMode } from './rounding.js';

/** A non-negative rational rate `num / den`, always reduced, with `den > 0`. */
export interface Rate {
  readonly num: bigint;
  readonly den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function rateFromFraction(num: bigint, den: bigint): Rate {
  if (den <= 0n) throw new RangeError('rate denominator must be positive');
  if (num < 0n) throw new RangeError('rates cannot be negative');
  const divisor = num === 0n ? den : gcd(num, den);
  return Object.freeze({ num: num / divisor, den: den / divisor });
}

/** Parses a plain fraction such as `"0.18"` (GST) into a rate. */
export function rateFromDecimalString(text: string): Rate {
  const { value, scale } = parseScaledDecimal(text);
  return rateFromFraction(value, pow10(scale));
}

/** Parses a percentage such as `"0.00297%"` into a rate. The `%` sign is required. */
export function rateFromPercentString(text: string): Rate {
  const trimmed = text.trim();
  if (!trimmed.endsWith('%')) throw new ParseError('percentage must end with %');
  const { value, scale } = parseScaledDecimal(trimmed.slice(0, -1));
  return rateFromFraction(value, pow10(scale) * 100n);
}

/** `amountMicro × rate`, rounded to a whole micro-rupee with `mode`. Exact for any size. */
export function applyRate(amountMicro: bigint, rate: Rate, mode: RoundingMode): bigint {
  return divRound(amountMicro * rate.num, rate.den, mode);
}
