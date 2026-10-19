import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MICRO_PER_PAISA,
  MICRO_PER_RUPEE,
  normaliseDecimalString,
  parseDecimalToMicro,
  roundMicro,
} from '../../src/money/index.js';
import { InvalidArgumentError, ParseError, PrecisionError } from '../../src/errors.js';

describe('constants', () => {
  it('defines rupee and paisa in micro-rupees', () => {
    expect(MICRO_PER_RUPEE).toBe(1_000_000n);
    expect(MICRO_PER_PAISA).toBe(10_000n);
  });
});

describe('parseDecimalToMicro', () => {
  it.each([
    ['700.60', 700_600_000n],
    ['0', 0n],
    ['-0', 0n],
    ['-12.5', -12_500_000n],
    [' 1.000001 ', 1_000_001n],
    ['+3', 3_000_000n],
    ['700.599976', 700_599_976n],
    ['9007199254740993.123456', 9_007_199_254_740_993_123_456n],
  ])('parses %s exactly', (input, expected) => {
    expect(parseDecimalToMicro(input)).toBe(expected);
  });

  it.each(['', ' ', 'abc', '1e5', '1,000.00', '.5', '1.', '--1', '1.2.3', 'NaN', 'Infinity'])(
    'rejects %j with ParseError',
    (input) => {
      expect(() => parseDecimalToMicro(input)).toThrow(ParseError);
    },
  );

  it('rejects more than 6 fractional digits without a rounding mode', () => {
    expect(() => parseDecimalToMicro('1.0000005')).toThrow(PrecisionError);
  });

  it.each([
    ['1.0000005', 'half-up', 1_000_001n],
    ['1.0000005', 'half-even', 1_000_000n],
    ['1.0000015', 'half-even', 1_000_002n],
    ['1.0000005', 'floor', 1_000_000n],
    ['1.0000005', 'ceil', 1_000_001n],
    ['-1.0000005', 'half-up', -1_000_001n],
    ['-1.0000005', 'floor', -1_000_001n],
    ['-1.0000005', 'ceil', -1_000_000n],
    ['0.0000004', 'half-up', 0n],
  ] as const)('rounds %s with %s', (input, mode, expected) => {
    expect(parseDecimalToMicro(input, { round: mode })).toBe(expected);
  });

  it('round-trips every 6-dp decimal string (property)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 21n), max: 10n ** 21n }), (micro) => {
        const negative = micro < 0n;
        const abs = negative ? -micro : micro;
        const text = `${negative ? '-' : ''}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, '0')}`;
        expect(parseDecimalToMicro(text)).toBe(micro);
      }),
    );
  });
});

describe('normaliseDecimalString', () => {
  it.each([
    ['700.599976', 2, 'half-up', '700.60'],
    ['3130.600098', 2, 'half-up', '3130.60'],
    ['169.56', 2, 'half-up', '169.56'],
    ['5', 2, 'half-up', '5.00'],
    ['0.005', 2, 'half-up', '0.01'],
    ['0.005', 2, 'half-even', '0.00'],
    ['-0.005', 2, 'half-up', '-0.01'],
    ['-0.004', 2, 'half-up', '0.00'],
    ['293116.94999999995', 2, 'half-up', '293116.95'],
    ['1.2345', 0, 'half-up', '1'],
    ['12', 0, 'half-up', '12'],
  ] as const)('normalises %s to %i dp (%s) as %s', (input, dp, mode, expected) => {
    expect(normaliseDecimalString(input, dp, mode)).toBe(expected);
  });

  it.each([-1, 1.5, Number.NaN])('rejects dp %s', (dp) => {
    expect(() => normaliseDecimalString('1.5', dp, 'half-up')).toThrow(InvalidArgumentError);
  });

  it('rejects malformed input', () => {
    expect(() => normaliseDecimalString('1e3', 2, 'half-up')).toThrow(ParseError);
  });
});

describe('roundMicro', () => {
  it.each([
    [15_390_000n, 'rupee', 'half-up', 15_000_000n],
    [15_500_000n, 'rupee', 'half-up', 16_000_000n],
    [52_500_000n, 'rupee', 'half-up', 53_000_000n],
    [30_870_100n, 'rupee', 'half-up', 31_000_000n],
    [-15_500_000n, 'rupee', 'half-up', -16_000_000n],
    [1_234_567n, 'paisa', 'half-up', 1_230_000n],
    [1_235_000n, 'paisa', 'half-even', 1_240_000n],
    [1_225_000n, 'paisa', 'half-even', 1_220_000n],
    [1_239_999n, 'paisa', 'floor', 1_230_000n],
    [1_230_001n, 'paisa', 'ceil', 1_240_000n],
    [174_049_999n, 50_000n, 'half-up', 174_050_000n],
  ] as const)('rounds %s to %s (%s)', (value, unit, mode, expected) => {
    expect(roundMicro(value, unit, mode)).toBe(expected);
  });

  it('rejects a non-positive unit', () => {
    expect(() => roundMicro(1n, 0n, 'half-up')).toThrow(InvalidArgumentError);
    expect(() => roundMicro(1n, -5n, 'half-up')).toThrow(InvalidArgumentError);
  });

  it('always returns a multiple of the unit within one unit of the input (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }),
        fc.constantFrom('half-up', 'half-even', 'floor', 'ceil' as const),
        (value, mode) => {
          const rounded = roundMicro(value, 'paisa', mode);
          expect(rounded % MICRO_PER_PAISA).toBe(0n);
          const diff = rounded > value ? rounded - value : value - rounded;
          expect(diff < MICRO_PER_PAISA).toBe(true);
        },
      ),
    );
  });
});
