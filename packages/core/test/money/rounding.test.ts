import { describe, expect, it } from 'vitest';
import { divRound } from '../../src/money/index.js';

describe('divRound', () => {
  it.each([
    [7n, 2n, 'half-up', 4n],
    [-7n, 2n, 'half-up', -4n],
    [5n, 2n, 'half-even', 2n],
    [7n, 2n, 'half-even', 4n],
    [-5n, 2n, 'half-even', -2n],
    [7n, 3n, 'half-up', 2n],
    [8n, 3n, 'half-up', 3n],
    [7n, 2n, 'floor', 3n],
    [-7n, 2n, 'floor', -4n],
    [7n, 2n, 'ceil', 4n],
    [-7n, 2n, 'ceil', -3n],
    [6n, 3n, 'half-up', 2n],
  ] as const)('%s / %s with %s = %s', (numerator, denominator, mode, expected) => {
    expect(divRound(numerator, denominator, mode)).toBe(expected);
  });

  it('rejects a zero or negative denominator', () => {
    expect(() => divRound(1n, 0n, 'half-up')).toThrow(RangeError);
    expect(() => divRound(1n, -2n, 'floor')).toThrow(RangeError);
  });
});
