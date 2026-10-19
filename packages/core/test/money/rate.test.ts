import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyRate,
  rateFromDecimalString,
  rateFromFraction,
  rateFromPercentString,
  roundMicro,
} from '../../src/money/index.js';
import { InvalidArgumentError, ParseError } from '../../src/errors.js';

const ONE_LAKH_MICRO = 100_000_000_000n;

describe('rates', () => {
  it('parses a percentage into a reduced rational', () => {
    expect(rateFromPercentString('0.00297%')).toEqual({ num: 297n, den: 10_000_000n });
    expect(rateFromPercentString('0.1%')).toEqual({ num: 1n, den: 1000n });
    expect(rateFromPercentString(' 18 % ')).toEqual({ num: 9n, den: 50n });
  });

  it('parses a decimal fraction into a reduced rational', () => {
    expect(rateFromDecimalString('0.18')).toEqual({ num: 9n, den: 50n });
    expect(rateFromDecimalString('1')).toEqual({ num: 1n, den: 1n });
    expect(rateFromDecimalString('0')).toEqual({ num: 0n, den: 1n });
  });

  it('builds a rate from a fraction', () => {
    expect(rateFromFraction(6n, 8n)).toEqual({ num: 3n, den: 4n });
    expect(() => rateFromFraction(1n, 0n)).toThrow(InvalidArgumentError);
    expect(() => rateFromFraction(-1n, 2n)).toThrow(InvalidArgumentError);
  });

  it.each(['0.1', 'abc%', '%', '1e-3%', '-0.1%'])('rejects %j as a percentage', (input) => {
    expect(() => rateFromPercentString(input)).toThrow(ParseError);
  });

  it('rejects negative decimal rates', () => {
    expect(() => rateFromDecimalString('-0.18')).toThrow(ParseError);
  });
});

describe('applyRate (golden values from the Dhan FY 2024-25 statement)', () => {
  it('NSE transaction charge: Rs 2.97 per lakh at 0.00297%', () => {
    expect(applyRate(ONE_LAKH_MICRO, rateFromPercentString('0.00297%'), 'half-up')).toBe(2_970_000n);
  });

  it('delivery STT on a Rs 30,870.10 contract note rounds to Rs 31', () => {
    const stt = applyRate(30_870_100_000n, rateFromPercentString('0.1%'), 'half-up');
    expect(stt).toBe(30_870_100n);
    expect(roundMicro(stt, 'rupee', 'half-up')).toBe(31_000_000n);
  });

  it('GST at 18% on Rs 4.61 is Rs 0.8298, shown as Rs 0.83', () => {
    const gst = applyRate(4_610_000n, rateFromDecimalString('0.18'), 'half-up');
    expect(gst).toBe(829_800n);
    expect(roundMicro(gst, 'paisa', 'half-up')).toBe(830_000n);
  });

  it('rounds sub-micro results with the requested mode', () => {
    const third = rateFromFraction(1n, 3n);
    expect(applyRate(1n, third, 'half-up')).toBe(0n);
    expect(applyRate(2n, third, 'half-up')).toBe(1n);
    expect(applyRate(1n, third, 'ceil')).toBe(1n);
    expect(applyRate(-2n, third, 'half-up')).toBe(-1n);
  });

  it('is monotonic in the amount (property)', () => {
    const rate = rateFromPercentString('0.00297%');
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 21n }),
        fc.bigInt({ min: 0n, max: 10n ** 21n }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(applyRate(lo, rate, 'half-up') <= applyRate(hi, rate, 'half-up')).toBe(true);
        },
      ),
    );
  });
});
