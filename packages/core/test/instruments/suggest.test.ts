// Manual-mapping suggestions (plan S8): ranked by normalised token overlap, with acronyms recognised.
import { describe, expect, it } from 'vitest';
import { normaliseName, suggestInstruments } from '../../src/index.js';

const OPTIONS = [
  { name: 'REC', isin: 'INE020B01018' },
  { name: 'Rural Electrification Corporation', isin: 'INE020B01018' },
  { name: 'Hindustan Construction Company', isin: 'INE549A01026' },
  { name: 'Hindustan Aeronautics', isin: 'INE066F01020' },
  { name: 'Tata Teleservices Maharashtra', isin: 'INE517B01013' },
];

describe('normaliseName', () => {
  it('lower-cases, drops punctuation and legal suffixes, and keeps the tokens in order', () => {
    expect(normaliseName('Sterling & Wilson Renewable Energy Ltd.')).toEqual(['sterling', 'wilson', 'renewable', 'energy']);
    expect(normaliseName('  THE Bank of Maharashtra Limited ')).toEqual(['bank', 'maharashtra']);
  });
});

describe('suggestInstruments', () => {
  it('ranks by token overlap', () => {
    expect(suggestInstruments('Hindustan Construction Co', OPTIONS).map((entry) => entry.name)).toEqual([
      'Hindustan Construction Company',
      'Hindustan Aeronautics',
    ]);
  });

  it('recognises an acronym of the candidate name', () => {
    const [top] = suggestInstruments('HCC', OPTIONS);
    expect(top).toMatchObject({ name: 'Hindustan Construction Company', isin: 'INE549A01026' });
    expect(suggestInstruments('REC', OPTIONS)[0]?.isin).toBe('INE020B01018');
  });

  it('returns nothing for no overlap, caps the list, and breaks ties by name', () => {
    expect(suggestInstruments('Zydus', OPTIONS)).toEqual([]);
    expect(suggestInstruments('Hindustan', OPTIONS, 1).map((entry) => entry.name)).toEqual(['Hindustan Aeronautics']);
  });
});
