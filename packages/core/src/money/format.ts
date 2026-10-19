// The single display formatter for money (domain.md: round only at the UI layer, through one helper).
import { formatScaled, pow10 } from './decimal.js';
import { InvalidArgumentError } from '../errors.js';
import { divRound } from './rounding.js';

export interface FormatINROptions {
  /** Fractional digits to show: 2 (paise, default) or 0 (whole rupees). */
  readonly dp?: 0 | 2;
  /** Prefix with ₹ (default true). */
  readonly symbol?: boolean;
}

/** Groups an integer string the Indian way: last three digits, then pairs (1,23,45,678). */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${head},${digits.slice(-3)}`;
}

/** Formats micro-rupees for display, e.g. `123_456_780_000n` → `₹1,23,456.78`. Rounds half-up. */
export function formatINR(valueMicro: bigint, options: FormatINROptions = {}): string {
  // Widened on purpose: guards untyped (JS or cast) callers at runtime.
  const dp: number = options.dp ?? 2;
  if (dp !== 0 && dp !== 2) throw new InvalidArgumentError('dp must be 0 or 2');
  const rounded = divRound(valueMicro, pow10(6 - dp), 'half-up');
  const plain = formatScaled(rounded < 0n ? -rounded : rounded, dp);
  const [integerPart = '0', fraction] = plain.split('.');
  const body = groupIndian(integerPart) + (fraction === undefined ? '' : `.${fraction}`);
  return `${rounded < 0n ? '-' : ''}${options.symbol === false ? '' : '₹'}${body}`;
}
