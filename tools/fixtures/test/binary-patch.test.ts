import { describe, expect, it } from 'vitest';
import { patchBinary } from '../src/binary-patch.js';

describe('patchBinary', () => {
  it('replaces latin1 and UTF-16LE occurrences in place, keeping the length', () => {
    const original = Buffer.concat([
      Buffer.from('head|97XXXXXX91|', 'latin1'),
      Buffer.from('97XXXXXX91', 'utf16le'),
      Buffer.from('|tail', 'latin1'),
    ]);
    const { bytes, counts } = patchBinary(original, [{ from: '97XXXXXX91', to: '1234567890' }]);
    expect(bytes.length).toBe(original.length);
    expect(bytes.toString('latin1')).toContain('head|1234567890|');
    expect(bytes.includes(Buffer.from('1234567890', 'utf16le'))).toBe(true);
    expect(bytes.includes(Buffer.from('97XXXXXX91', 'latin1'))).toBe(false);
    expect(counts).toEqual([2]);
  });

  it('refuses replacements that would change the length', () => {
    expect(() => patchBinary(Buffer.from('abcd'), [{ from: 'abcd', to: 'abcde' }])).toThrow(/same length/);
  });

  it('refuses a value that does not occur (e.g. stored as a number, not text)', () => {
    expect(() => patchBinary(Buffer.from('abcd'), [{ from: 'zzzz', to: 'yyyy' }])).toThrow(/not found/);
  });

  it('refuses values too short to patch safely', () => {
    expect(() => patchBinary(Buffer.from('a-b'), [{ from: 'a', to: 'X' }])).toThrow(/too short/);
  });

  it('only replaces whole tokens, never inside a longer word', () => {
    const { bytes } = patchBinary(Buffer.from('secret|mysecrets|secret', 'latin1'), [
      { from: 'secret', to: 'XXXXXX' },
    ]);
    expect(bytes.toString('latin1')).toBe('XXXXXX|mysecrets|XXXXXX');
  });

  it('patches non-latin1 text in its UTF-16LE form only', () => {
    const original = Buffer.from('|Ravi Kumār|', 'utf16le');
    const { bytes } = patchBinary(original, [{ from: 'Ravi Kumār', to: 'XXXXXXXXXX' }]);
    expect(bytes.toString('utf16le')).toBe('|XXXXXXXXXX|');
  });

  it('does not touch the input buffer', () => {
    const original = Buffer.from('xx-secret-xx', 'latin1');
    patchBinary(original, [{ from: 'secret', to: 'XXXXXX' }]);
    expect(original.toString('latin1')).toBe('xx-secret-xx');
  });
});

describe('patchBinary boundaries', () => {
  it('treats a single alphanumeric neighbour byte (e.g. a BIFF length byte) as binary, not text', () => {
    const original = Buffer.concat([Buffer.from([0x00, 0x41]), Buffer.from('secret', 'latin1'), Buffer.from([0x31, 0x00])]);
    const { bytes } = patchBinary(original, [{ from: 'secret', to: 'XXXXXX' }]);
    expect(bytes.subarray(2, 8).toString('latin1')).toBe('XXXXXX');
  });
});
