// S10b-1 task 3: suspicion heuristics. Suggestions only (ADR-0015: never applied automatically).
import { describe, expect, it } from 'vitest';
import { reconstructAccount, suspectCorporateActions } from '../../src/index.js';
import { fill } from '../fifo/helpers.js';

type Spec = readonly [side: 'BUY' | 'SELL', qty: number, at: string, instrument: string];

function suspicions(specs: readonly Spec[]) {
  const fills = specs.map(([side, qty, at, instrument]) =>
    fill({ side, qty, price: 100, at: `${at} 10:00`, product: 'DELIVERY', instrument }),
  );
  return suspectCorporateActions(reconstructAccount(fills, []));
}

describe('(a) missed split or bonus', () => {
  it('flags a sell beyond the holding that is a whole multiple of it', () => {
    expect(
      suspicions([
        ['BUY', 10, '2025-01-01', 'X'],
        ['SELL', 50, '2025-04-01', 'X'],
      ]),
    ).toEqual([
      { kind: 'split_or_bonus', accountId: 'acc', instrumentKey: 'X', dateIst: '2025-04-01', multiple: 5n },
    ]);
  });

  it.each<[string, Spec[]]>([
    [
      'a non-multiple',
      [
        ['BUY', 10, '2025-01-01', 'X'],
        ['SELL', 15, '2025-04-01', 'X'],
      ],
    ],
    [
      'a sell within the holding',
      [
        ['BUY', 10, '2025-01-01', 'X'],
        ['SELL', 10, '2025-04-01', 'X'],
      ],
    ],
    ['nothing held', [['SELL', 5, '2025-04-01', 'X']]],
    [
      'a one-share holding (every sell is a multiple)',
      [
        ['BUY', 1, '2025-01-01', 'X'],
        ['SELL', 7, '2025-04-01', 'X'],
      ],
    ],
  ])('stays quiet for %s', (_, specs) => {
    expect(suspicions(specs)).toEqual([]);
  });
});

describe('(b) missed conversion or demerger', () => {
  it('flags a quiet holding when a new instrument appears selling a related quantity', () => {
    expect(
      suspicions([
        ['BUY', 10, '2025-01-01', 'OLD'],
        ['SELL', 20, '2025-06-01', 'NEW'],
      ]),
    ).toEqual([
      {
        kind: 'conversion_or_demerger',
        accountId: 'acc',
        fromInstrument: 'OLD',
        toInstrument: 'NEW',
        dateIst: '2025-06-01',
      },
    ]);
  });

  it('compares with what is still open', () => {
    const found = suspicions([
      ['BUY', 10, '2025-01-01', 'OLD'],
      ['SELL', 2, '2025-02-01', 'OLD'],
      ['SELL', 16, '2025-06-01', 'NEW'],
    ]);
    expect(found.map((entry) => entry.kind)).toEqual(['conversion_or_demerger']);
  });

  it.each<[string, Spec[]]>([
    [
      'an unrelated quantity',
      [
        ['BUY', 10, '2025-01-01', 'OLD'],
        ['SELL', 7, '2025-06-01', 'NEW'],
      ],
    ],
    [
      'a buy (not an orphan)',
      [
        ['BUY', 10, '2025-01-01', 'OLD'],
        ['BUY', 10, '2025-06-01', 'NEW'],
      ],
    ],
    [
      'a holding still active after the new instrument appeared',
      [
        ['BUY', 10, '2025-01-01', 'OLD'],
        ['SELL', 10, '2025-06-01', 'NEW'],
        ['BUY', 1, '2025-07-01', 'OLD'],
      ],
    ],
    [
      'a one-share sell (related to everything)',
      [
        ['BUY', 10, '2025-01-01', 'OLD'],
        ['SELL', 1, '2025-06-01', 'NEW'],
      ],
    ],
    [
      'a holding quiet for over a year',
      [
        ['BUY', 10, '2024-01-01', 'OLD'],
        ['SELL', 10, '2025-06-01', 'NEW'],
      ],
    ],
    [
      'two quiet holdings that could both explain it',
      [
        ['BUY', 10, '2025-01-01', 'A'],
        ['BUY', 5, '2025-01-02', 'B'],
        ['SELL', 10, '2025-06-01', 'NEW'],
      ],
    ],
  ])('stays quiet for %s', (_, specs) => {
    expect(suspicions(specs).filter((entry) => entry.kind === 'conversion_or_demerger')).toEqual([]);
  });
});
