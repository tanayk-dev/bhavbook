/**
 * Rounding modes for exact integer division.
 * - `half-up`: ties round away from zero (commercial rounding; what brokers use for STT and stamp duty)
 * - `half-even`: ties round to the even neighbour (banker's rounding)
 * - `floor` / `ceil`: toward negative / positive infinity
 */
export type RoundingMode = 'half-up' | 'half-even' | 'floor' | 'ceil';

/** Divides `numerator` by a positive `denominator` and rounds the quotient with `mode`. Exact for any size. */
export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;

  const sign = numerator < 0n ? -1n : 1n;
  switch (mode) {
    case 'floor':
      return sign < 0n ? quotient - 1n : quotient;
    case 'ceil':
      return sign > 0n ? quotient + 1n : quotient;
    case 'half-up':
    case 'half-even': {
      const twiceRemainder = 2n * (remainder < 0n ? -remainder : remainder);
      if (twiceRemainder > denominator) return quotient + sign;
      if (twiceRemainder < denominator) return quotient;
      if (mode === 'half-up') return quotient + sign;
      return quotient % 2n === 0n ? quotient : quotient + sign;
    }
  }
}
