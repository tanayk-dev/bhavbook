// Fixed, obviously fake values used to replace personal data in fixtures. The PII scanner allowlists them.
export const PLACEHOLDERS = {
  name: 'TEST USER',
  ucc: 'XXXX00000X',
  clientId: 'XX0000',
  pan: 'XXXXX0000X',
  mobile: '1234567890',
  email: 'test@example.com',
  bank: 'TEST BANK',
} as const;

export type PlaceholderKey = keyof typeof PLACEHOLDERS;

/**
 * A demat account number after its label: group 1 = label and separator, group 2 = the number.
 * CDSL BOID is 16 digits (8-digit DP ID + 8-digit client ID); NSDL is `IN` + 6-digit DP ID + 8-digit client ID.
 */
export const DEMAT_PATTERN =
  /(?<![A-Za-z0-9])((?:BO\s?ID|DP\s?ID|Demat(?:\s+(?:A\/c|Account))?(?:\s+(?:No|Number))?)\.?\s*[:#-]?\s*)((?:IN\d{14})|\d{16})(?![A-Za-z0-9])/gi;

/** Keeps the public 8-character DP ID and zeroes the client part. */
export function redactDematNumber(number: string): string {
  return number.slice(0, 8) + '0'.repeat(number.length - 8);
}

/** Email placeholders padded to a length: `test@example.com`, `testxxxx@example.com`, … */
export const EMAIL_PLACEHOLDER_PATTERN = /^testx*@example\.com$/;

/**
 * A placeholder of exactly `length` characters, for same-length binary patching.
 * Names and banks pad with spaces, emails pad the local part with `x`; anything that doesn't fit becomes `X…`.
 */
export function fitPlaceholder(key: PlaceholderKey, length: number): string {
  const base: string = PLACEHOLDERS[key];
  if (base.length === length) return base;
  if (key === 'email' && length > base.length) return `test${'x'.repeat(length - base.length)}@example.com`;
  if ((key === 'name' || key === 'bank') && length > base.length) return base.padEnd(length, ' ');
  return 'X'.repeat(length);
}

/** True when `value` is (a padded form of) the placeholder or already redacted, so scrubbing is idempotent. */
export function isPlaceholderValue(key: PlaceholderKey, value: string): boolean {
  // Already redacted by hand (e.g. `XXXXX XXXXX XXXXX`, `XXX000`): leave as is.
  if (/^[X0\s]+$/.test(value) && value.includes('X')) return true;
  if (key === 'email') return EMAIL_PLACEHOLDER_PATTERN.test(value);
  if (key === 'name' || key === 'bank') return value.trim() === PLACEHOLDERS[key];
  return value === PLACEHOLDERS[key];
}
