import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocateLargestRemainder } from '../../src/money/index.js';

describe('allocateLargestRemainder', () => {
  it.each([
    [100n, [1n, 1n, 1n], [34n, 33n, 33n]],
    [10n, [3n, 3n, 4n], [3n, 3n, 4n]],
    [10n, [1n, 1n], [5n, 5n]],
    [7n, [1n, 1n], [4n, 3n]],
    [0n, [1n, 2n], [0n, 0n]],
    [-7n, [1n, 1n], [-4n, -3n]],
    [5n, [0n, 1n], [0n, 5n]],
    [0n, [], []],
    [0n, [0n, 0n], [0n, 0n]],
  ])('allocates %s over %s as %s', (total, weights, expected) => {
    expect(allocateLargestRemainder(total, weights)).toEqual(expected);
  });

  it('splits a day STT total across scrips by value (Dhan 22 Apr 2024)', () => {
    const weights = [15_257_500_000n, 7_347_600_000n, 8_265_000_000n];
    const parts = allocateLargestRemainder(31_000_000n, weights);
    expect(parts.reduce((sum, part) => sum + part, 0n)).toBe(31_000_000n);
    // Exact largest-remainder split (computed independently); Dhan's own paise-rounded split was 15.39/7.35/8.27.
    expect(parts).toEqual([15_321_703n, 7_378_518n, 8_299_779n]);
  });

  it('rejects a non-zero total with no weight to carry it', () => {
    expect(() => allocateLargestRemainder(5n, [])).toThrow(RangeError);
    expect(() => allocateLargestRemainder(5n, [0n, 0n])).toThrow(RangeError);
  });

  it('rejects negative weights', () => {
    expect(() => allocateLargestRemainder(5n, [1n, -1n])).toThrow(RangeError);
  });

  it('always sums exactly and stays within one unit of the exact share (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 15n }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          const weightSum = weights.reduce((sum, w) => sum + w, 0n);
          fc.pre(weightSum > 0n);
          const parts = allocateLargestRemainder(total, weights);
          expect(parts.reduce((sum, part) => sum + part, 0n)).toBe(total);
          const absTotal = total < 0n ? -total : total;
          parts.forEach((part, index) => {
            const floorShare = (absTotal * (weights[index] ?? 0n)) / weightSum;
            const absPart = part < 0n ? -part : part;
            expect(absPart >= floorShare && absPart <= floorShare + 1n).toBe(true);
          });
        },
      ),
    );
  });
});
