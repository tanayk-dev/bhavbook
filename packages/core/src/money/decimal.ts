// Decimal strings to and from bigint, without ever going through a float (ADR-0004, ADR-0010).
import { InvalidArgumentError, ParseError, PrecisionError } from '../errors.js';
import { divRound, type RoundingMode } from './rounding.js';

export const MICRO_PER_RUPEE = 1_000_000n;
export const MICRO_PER_PAISA = 10_000n;

const MICRO_DIGITS = 6;
const DECIMAL_PATTERN = /^\s*([+-])?(\d+)(?:\.(\d+))?\s*$/;

/** A signed integer `value` that represents `value / 10^scale`. */
export interface ScaledDecimal {
  readonly value: bigint;
  readonly scale: number;
}

export function pow10(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0) {
    throw new InvalidArgumentError('exponent must be a non-negative integer');
  }
  return 10n ** BigInt(exponent);
}

/** Parses `[+-]digits[.digits]` (surrounding whitespace allowed). No exponents, separators or bare dots. */
export function parseScaledDecimal(text: string): ScaledDecimal {
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) throw new ParseError('not a plain decimal number');
  const [, sign, integerDigits = '', fractionDigits = ''] = match;
  const magnitude = BigInt(integerDigits + fractionDigits);
  return { value: sign === '-' ? -magnitude : magnitude, scale: fractionDigits.length };
}

/** Rescales a decimal to `targetScale` digits, rounding with `mode` only when digits are dropped. */
export function rescale(decimal: ScaledDecimal, targetScale: number, mode: RoundingMode): bigint {
  if (decimal.scale <= targetScale) return decimal.value * pow10(targetScale - decimal.scale);
  return divRound(decimal.value, pow10(decimal.scale - targetScale), mode);
}

export interface ParseMicroOptions {
  /** Required when the input has more than 6 fractional digits. */
  readonly round?: RoundingMode;
}

/** Parses a decimal rupee string into micro-rupees, exactly. */
export function parseDecimalToMicro(text: string, options: ParseMicroOptions = {}): bigint {
  const decimal = parseScaledDecimal(text);
  if (decimal.scale > MICRO_DIGITS && options.round === undefined) {
    throw new PrecisionError('more than 6 fractional digits; pass a rounding mode');
  }
  return rescale(decimal, MICRO_DIGITS, options.round ?? 'half-up');
}

/** Formats a scaled integer as a decimal string with exactly `dp` fractional digits. */
export function formatScaled(value: bigint, dp: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const unit = pow10(dp);
  const integerPart = (magnitude / unit).toString();
  const fraction = dp === 0 ? '' : `.${(magnitude % unit).toString().padStart(dp, '0')}`;
  return `${negative ? '-' : ''}${integerPart}${fraction}`;
}

/**
 * Rewrites a decimal string to exactly `dp` fractional digits, as a string operation.
 * Used by adapters for declared precision normalisation, e.g. Zerodha's `700.599976` → `700.60`.
 */
export function normaliseDecimalString(text: string, dp: number, mode: RoundingMode): string {
  pow10(dp); // validates dp before any work
  return formatScaled(rescale(parseScaledDecimal(text), dp, mode), dp);
}

export type RoundingUnit = 'paisa' | 'rupee' | bigint;

/** Rounds micro-rupees to a whole multiple of `unit` (paisa, rupee, or any positive micro amount). */
export function roundMicro(valueMicro: bigint, unit: RoundingUnit, mode: RoundingMode): bigint {
  const unitMicro = unit === 'paisa' ? MICRO_PER_PAISA : unit === 'rupee' ? MICRO_PER_RUPEE : unit;
  if (unitMicro <= 0n) throw new InvalidArgumentError('rounding unit must be positive');
  return divRound(valueMicro, unitMicro, mode) * unitMicro;
}
