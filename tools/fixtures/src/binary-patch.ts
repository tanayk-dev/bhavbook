// Same-length, in-place string replacement inside binary files (legacy .xls / BIFF8).
// Rewriting .xls with SheetJS CE truncates every text cell to 255 characters, so we patch the original bytes instead:
// record lengths stay valid and every byte we don't replace is untouched. Callers must re-read and verify the result.

export interface Replacement {
  readonly from: string;
  readonly to: string;
}

export interface PatchResult {
  readonly bytes: Buffer;
  /** Occurrences replaced per replacement (latin1 + UTF-16LE). */
  readonly counts: readonly number[];
}

/** Shortest value we will search for: shorter strings occur by chance inside unrelated records. */
export const MIN_PATCH_LENGTH = 4;

function isAsciiAlnum(code: number | undefined): boolean {
  return code !== undefined && ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122));
}

/** The character (ASCII code) at `offset` in latin1 (unit 1) or UTF-16LE (unit 2), or undefined. */
function charAt(target: Buffer, offset: number, unit: 1 | 2): number | undefined {
  if (offset < 0 || offset + unit > target.length) return undefined;
  if (unit === 2 && target[offset + 1] !== 0) return undefined;
  return target[offset];
}

/**
 * True when the match is not part of a longer word (so `secret` never matches inside `secrets`).
 * A neighbour only counts as "glued" when it starts a run of two word characters: a single alphanumeric byte
 * next to the match is usually binary (e.g. the next BIFF string's length byte), not text.
 */
function atBoundary(target: Buffer, index: number, length: number, unit: 1 | 2): boolean {
  const glued = (first: number | undefined, second: number | undefined): boolean =>
    isAsciiAlnum(first) && isAsciiAlnum(second);
  const before = glued(charAt(target, index - unit, unit), charAt(target, index - 2 * unit, unit));
  const after = glued(charAt(target, index + length, unit), charAt(target, index + length + unit, unit));
  return !before && !after;
}

function replaceAll(target: Buffer, from: Buffer, to: Buffer, unit: 1 | 2): number {
  let count = 0;
  for (let index = target.indexOf(from); index !== -1; index = target.indexOf(from, index + 1)) {
    if (!atBoundary(target, index, from.length, unit)) continue;
    to.copy(target, index);
    count += 1;
  }
  return count;
}

function isLatin1(text: string): boolean {
  return [...text].every((char) => (char.codePointAt(0) ?? 0) <= 0xff);
}

export function patchBinary(input: Buffer, replacements: readonly Replacement[]): PatchResult {
  const bytes = Buffer.from(input);
  const counts = replacements.map(({ from, to }, index) => {
    if (from.length !== to.length) throw new Error('binary replacements must keep the same length');
    if (from.length < MIN_PATCH_LENGTH) throw new Error(`replacement #${index} is too short to patch safely`);
    const latin1 = isLatin1(from) && isLatin1(to);
    const count =
      (latin1 ? replaceAll(bytes, Buffer.from(from, 'latin1'), Buffer.from(to, 'latin1'), 1) : 0) +
      replaceAll(bytes, Buffer.from(from, 'utf16le'), Buffer.from(to, 'utf16le'), 2);
    if (count === 0) {
      // Report the value's shape only (letters → a, digits → 9), never the value itself.
      const shape = from.replace(/[A-Za-z]/g, 'a').replace(/\d/g, '9');
      throw new Error(`replacement #${index} (${shape}) not found as text; it may be stored as a number`);
    }
    return count;
  });
  return { bytes, counts };
}
