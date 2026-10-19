// ADR-0014 / plan S8: the transaction join and its fallbacks, on synthetic day aggregates.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  aggregateByDay,
  fillIsinsBySymbol,
  mergeDayAggregates,
  resolveAliases,
  type DayAggregate,
} from '../../src/index.js';

const REC = 'INE020B01018';
const HCC = 'INE549A01026';
const IRFC = 'INE053F01010';
const BHARTI = 'INE343G01021';

function day(
  date: string,
  name: string,
  buyQty: bigint,
  sellQty: bigint,
  buyValueMicro = 0n,
  sellValueMicro = 0n,
): DayAggregate {
  return { date, name, buyQty, sellQty, buyValueMicro, sellValueMicro };
}

describe('aggregateByDay', () => {
  it('sums quantities and values per (date, name) and side', () => {
    expect(
      aggregateByDay([
        {
          date: '2024-06-04',
          name: 'Rural Electrification Corporation',
          side: 'BUY',
          quantity: 15n,
          valueMicro: 8_133_000_000n,
        },
        {
          date: '2024-06-04',
          name: 'Rural Electrification Corporation',
          side: 'BUY',
          quantity: 5n,
          valueMicro: 2_711_000_000n,
        },
        {
          date: '2024-06-04',
          name: 'Rural Electrification Corporation',
          side: 'SELL',
          quantity: 20n,
          valueMicro: 10_423_000_000n,
        },
        { date: '2024-06-05', name: 'HCC', side: 'BUY', quantity: 1n, valueMicro: 1n },
      ]),
    ).toEqual([
      day('2024-06-04', 'Rural Electrification Corporation', 20n, 20n, 10_844_000_000n, 10_423_000_000n),
      day('2024-06-05', 'HCC', 1n, 0n, 1n, 0n),
    ]);
  });

  it('merges statement rows of the same day and name (several bills)', () => {
    expect(
      mergeDayAggregates([
        day('2024-06-04', 'REC', 10n, 0n, 5n, 0n),
        day('2024-06-04', 'REC', 10n, 20n, 5n, 9n),
      ]),
    ).toEqual([day('2024-06-04', 'REC', 20n, 20n, 10n, 9n)]);
  });
});

describe('resolveAliases: the transaction join', () => {
  const hints = [
    { name: 'REC', isin: REC },
    { name: 'Hindustan Construction Company', isin: HCC },
    { name: 'IRFC', isin: IRFC },
    { name: 'Bharti Hexacom', isin: BHARTI },
  ];

  it('maps a trade-file name to the statement name with the same day quantities, then to its ISIN', () => {
    const result = resolveAliases({
      trades: [
        day('2024-06-04', 'Rural Electrification Corporation', 20n, 20n),
        day('2024-06-25', 'HCC', 350n, 350n),
      ],
      statements: [
        day('2024-06-04', 'REC', 20n, 20n),
        day('2024-06-25', 'Hindustan Construction Company', 350n, 350n),
        day('2024-06-25', 'Something Else', 10n, 0n),
      ],
      hints,
      known: [],
    });
    expect(result).toEqual({
      resolved: [
        { alias: 'HCC', isin: HCC, source: 'join', via: 'Hindustan Construction Company' },
        { alias: 'Rural Electrification Corporation', isin: REC, source: 'join', via: 'REC' },
      ],
      unresolved: [],
    });
  });

  it('intersects evidence across days', () => {
    const result = resolveAliases({
      trades: [day('2024-05-23', 'X', 50n, 0n), day('2024-05-28', 'X', 0n, 50n)],
      statements: [
        day('2024-05-23', 'IRFC', 50n, 0n),
        day('2024-05-23', 'Bharti Hexacom', 50n, 0n),
        day('2024-05-28', 'IRFC', 0n, 50n),
      ],
      hints,
      known: [],
    });
    expect(result.resolved).toEqual([{ alias: 'X', isin: IRFC, source: 'join', via: 'IRFC' }]);
  });

  it('breaks a quantity tie by the closest values, then by the same name', () => {
    const byValue = resolveAliases({
      trades: [day('2024-05-23', 'Indian Railway Finance', 50n, 0n, 9_360_000_000n)],
      statements: [
        day('2024-05-23', 'IRFC', 50n, 0n, 9_360_010_000n),
        day('2024-05-23', 'Bharti Hexacom', 50n, 0n, 49_000_000_000n),
      ],
      hints,
      known: [],
    });
    expect(byValue.resolved).toEqual([
      { alias: 'Indian Railway Finance', isin: IRFC, source: 'join', via: 'IRFC' },
    ]);
    const byName = resolveAliases({
      trades: [day('2024-05-23', 'bharti  hexacom', 50n, 0n, 1n)],
      statements: [day('2024-05-23', 'IRFC', 50n, 0n, 1n), day('2024-05-23', 'Bharti Hexacom', 50n, 0n, 1n)],
      hints,
      known: [],
    });
    expect(byName.resolved).toEqual([
      { alias: 'bharti  hexacom', isin: BHARTI, source: 'join', via: 'Bharti Hexacom' },
    ]);
  });

  it('leaves a true tie, a contradiction, missing evidence and a missing ISIN unresolved, with the reason', () => {
    const result = resolveAliases({
      trades: [
        day('2024-05-23', 'Tie', 50n, 0n, 1n),
        day('2024-06-04', 'Contradiction', 20n, 0n),
        day('2024-06-05', 'Contradiction', 0n, 20n),
        day('2023-01-02', 'NoEvidence', 1n, 0n),
        day('2024-07-01', 'NoIsin', 5n, 0n),
      ],
      statements: [
        day('2024-05-23', 'IRFC', 50n, 0n, 1n),
        day('2024-05-23', 'Bharti Hexacom', 50n, 0n, 1n),
        day('2024-06-04', 'REC', 20n, 0n),
        day('2024-06-05', 'HCC Other', 0n, 20n),
        day('2024-07-01', 'Unhinted Name', 5n, 0n),
      ],
      hints,
      known: [],
    });
    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual([
      { alias: 'Contradiction', reason: 'no_match', candidates: [] },
      { alias: 'NoEvidence', reason: 'no_evidence', candidates: [] },
      { alias: 'NoIsin', reason: 'no_isin', candidates: ['Unhinted Name'] },
      { alias: 'Tie', reason: 'ambiguous', candidates: ['Bharti Hexacom', 'IRFC'] },
    ]);
  });

  it('falls back to a learned alias when the join has nothing to say', () => {
    const result = resolveAliases({
      trades: [day('2026-01-05', 'Rural Electrification Corporation', 10n, 0n)],
      statements: [],
      hints,
      known: [{ alias: 'Rural Electrification Corporation', isin: REC }],
    });
    expect(result.resolved).toEqual([
      { alias: 'Rural Electrification Corporation', isin: REC, source: 'learned', via: null },
    ]);
  });

  it('is deterministic: input order never changes the result', () => {
    const input = {
      trades: [
        day('2024-06-04', 'A', 20n, 20n),
        day('2024-06-25', 'B', 350n, 350n),
        day('2024-05-23', 'C', 50n, 0n, 1n),
      ],
      statements: [
        day('2024-06-04', 'REC', 20n, 20n),
        day('2024-06-25', 'Hindustan Construction Company', 350n, 350n),
        day('2024-05-23', 'IRFC', 50n, 0n, 1n),
        day('2024-05-23', 'Bharti Hexacom', 50n, 0n, 2n),
      ],
      hints,
      known: [],
    };
    const expected = resolveAliases(input);
    fc.assert(
      fc.property(
        fc.shuffledSubarray(input.trades, { minLength: 3 }),
        fc.shuffledSubarray(input.statements, { minLength: 4 }),
        (trades, statements) => {
          expect(resolveAliases({ ...input, trades, statements })).toEqual(expected);
        },
      ),
    );
  });
});

describe('fillIsinsBySymbol', () => {
  it('fills a blank ISIN from the same symbol elsewhere, and reports symbols with two ISINs', () => {
    expect(
      fillIsinsBySymbol([
        { symbol: 'FIVESTAR', isin: null },
        { symbol: 'FIVESTAR', isin: 'INE128S01021' },
        { symbol: 'ADVANCE', isin: null },
        { symbol: 'ADVANCE', isin: 'INE1B0W01010' },
        { symbol: 'ADVANCE', isin: 'INE1B0W01010' },
        { symbol: 'SPLIT', isin: 'INE000000011' },
        { symbol: 'SPLIT', isin: 'INE000000029' },
        { symbol: 'LONELY', isin: null },
      ]),
    ).toEqual({
      bySymbol: [
        { symbol: 'ADVANCE', isin: 'INE1B0W01010' },
        { symbol: 'FIVESTAR', isin: 'INE128S01021' },
      ],
      conflicts: ['SPLIT'],
      missing: ['LONELY'],
    });
  });
});
