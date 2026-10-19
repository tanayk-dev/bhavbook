import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { divRound, type RoundingMode } from '../../src/money/index.js';
import { BhavbookCoreError, InvalidArgumentError } from '../../src/errors.js';

/** Reference model: rounds the exact rational n/d using a scaled (×2) comparison, written independently. */
function referenceDivRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  const floorQ = n >= 0n ? n / d : -((-n + d - 1n) / d);
  const rem2 = 2n * (n - floorQ * d);
  if (rem2 === 0n) return floorQ;
  switch (mode) {
    case 'floor':
      return floorQ;
    case 'ceil':
      return floorQ + 1n;
    case 'half-up':
      if (rem2 === d) return n >= 0n ? floorQ + 1n : floorQ;
      return rem2 > d ? floorQ + 1n : floorQ;
    case 'half-even':
      if (rem2 === d) return floorQ % 2n === 0n ? floorQ : floorQ + 1n;
      return rem2 > d ? floorQ + 1n : floorQ;
  }
}

describe('divRound', () => {
  it.each([
    [7n, 2n, 'half-up', 4n],
    [-7n, 2n, 'half-up', -4n],
    [-5n, 2n, 'half-up', -3n],
    [5n, 2n, 'half-even', 2n],
    [7n, 2n, 'half-even', 4n],
    [-5n, 2n, 'half-even', -2n],
    [-7n, 2n, 'half-even', -4n],
    [7n, 3n, 'half-up', 2n],
    [8n, 3n, 'half-up', 3n],
    [7n, 2n, 'floor', 3n],
    [-7n, 2n, 'floor', -4n],
    [7n, 2n, 'ceil', 4n],
    [-7n, 2n, 'ceil', -3n],
    [6n, 3n, 'half-up', 2n],
    [6n, 3n, 'floor', 2n],
    [-6n, 3n, 'ceil', -2n],
    [0n, 5n, 'half-up', 0n],
  ] as const)('%s / %s with %s = %s', (numerator, denominator, mode, expected) => {
    expect(divRound(numerator, denominator, mode)).toBe(expected);
  });

  it('rejects a zero or negative denominator', () => {
    expect(() => divRound(1n, 0n, 'half-up')).toThrow(InvalidArgumentError);
    expect(() => divRound(1n, -2n, 'floor')).toThrow(InvalidArgumentError);
  });

  it('rejects an unknown rounding mode (e.g. from untyped rule JSON)', () => {
    expect(() => divRound(3n, 2n, 'nearest' as RoundingMode)).toThrow(InvalidArgumentError);
  });

  it('uses one error base class for every core failure', () => {
    expect(new InvalidArgumentError('x')).toBeInstanceOf(BhavbookCoreError);
  });

  it('matches an independent reference implementation (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.constantFrom<RoundingMode>('half-up', 'half-even', 'floor', 'ceil'),
        (n, d, mode) => {
          expect(divRound(n, d, mode)).toBe(referenceDivRound(n, d, mode));
        },
      ),
    );
  });
});
