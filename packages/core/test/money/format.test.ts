import { describe, expect, it } from 'vitest';
import { formatINR } from '../../src/money/index.js';

describe('formatINR (Indian digit grouping)', () => {
  it.each([
    [123_456_780_000n, '₹1,23,456.78'],
    [0n, '₹0.00'],
    [999_000_000n, '₹999.00'],
    [1_000_000_000n, '₹1,000.00'],
    [10_000_000_000_000n, '₹1,00,00,000.00'],
    [-750_000_000n, '-₹750.00'],
    [700_599_976n, '₹700.60'],
    [4_994n, '₹0.00'],
    [-4_994n, '₹0.00'],
    [5_000n, '₹0.01'],
  ])('formats %s as %s', (micro, expected) => {
    expect(formatINR(micro)).toBe(expected);
  });

  it('supports whole-rupee display', () => {
    expect(formatINR(15_500_000n, { dp: 0 })).toBe('₹16');
    expect(formatINR(1_234_567_000_000n, { dp: 0 })).toBe('₹12,34,567');
  });

  it('can omit the currency symbol', () => {
    expect(formatINR(123_456_780_000n, { symbol: false })).toBe('1,23,456.78');
    expect(formatINR(-1_500_000n, { symbol: false })).toBe('-1.50');
  });
});
