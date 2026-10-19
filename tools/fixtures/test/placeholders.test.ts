import { describe, expect, it } from 'vitest';
import { fitPlaceholder, isPlaceholderValue } from '../src/placeholders.js';

describe('fitPlaceholder', () => {
  it.each([
    ['email', 20, 'testxxxx@example.com'],
    ['email', 16, 'test@example.com'],
    ['mobile', 10, '1234567890'],
    ['name', 12, 'TEST USER   '],
    ['ucc', 10, 'XXXX00000X'],
    ['email', 10, 'XXXXXXXXXX'],
    ['name', 5, 'XXXXX'],
    ['ucc', 9, 'XXXXXXXXX'],
  ] as const)('fits %s to %i characters as %j', (key, length, expected) => {
    expect(fitPlaceholder(key, length)).toBe(expected);
  });
});

describe('isPlaceholderValue', () => {
  it('treats hand-redacted X values as already scrubbed', () => {
    expect(isPlaceholderValue('name', 'XXXXX XXXXX XXXXX')).toBe(true);
    expect(isPlaceholderValue('mobile', 'XXXXXXXXXX')).toBe(true);
    expect(isPlaceholderValue('clientId', 'XXX000')).toBe(true);
    expect(isPlaceholderValue('mobile', '0000000000')).toBe(false);
    expect(isPlaceholderValue('email', 'XXXXXXXXXX@XXXX.com')).toBe(false);
    expect(isPlaceholderValue('email', 'testxxx@example.com')).toBe(true);
    expect(isPlaceholderValue('name', 'TEST USER   ')).toBe(true);
  });
});
