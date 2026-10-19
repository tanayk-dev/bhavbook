// S8 review follow-ups: a join must agree on values too (a wrong mapping is worse than none), and conflicting
// name -> ISIN hints never resolve.
import { describe, expect, it } from 'vitest';
import { resolveAliases, type DayAggregate } from '../../src/index.js';

const RUPEE = 1_000_000n;

function day(date: string, name: string, buyQty: bigint, buyValueMicro: bigint): DayAggregate {
  return { date, name, buyQty, sellQty: 0n, buyValueMicro, sellValueMicro: 0n };
}

const hints = [
  { name: 'IRFC', isin: 'INE053F01010' },
  { name: 'Bharti Hexacom', isin: 'INE343G01021' },
];

describe('the join checks values', () => {
  it('refuses a lone quantity match whose value is far off', () => {
    const result = resolveAliases({
      trades: [day('2024-05-23', 'Coincidence', 10n, 100n * RUPEE)],
      statements: [day('2024-05-23', 'IRFC', 10n, 1_872n * RUPEE)],
      hints,
      known: [],
    });
    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual([{ alias: 'Coincidence', reason: 'value_mismatch', candidates: ['IRFC'] }]);
  });

  it('refuses the nearest of several candidates when none is close', () => {
    const result = resolveAliases({
      trades: [day('2024-05-23', 'Far', 50n, 100n * RUPEE)],
      statements: [day('2024-05-23', 'IRFC', 50n, 5_000n * RUPEE), day('2024-05-23', 'Bharti Hexacom', 50n, 6_000n * RUPEE)],
      hints,
      known: [],
    });
    expect(result.unresolved).toEqual([
      { alias: 'Far', reason: 'value_mismatch', candidates: ['Bharti Hexacom', 'IRFC'] },
    ]);
  });

  it('accepts paise-level rounding differences (seen on real files: up to Rs 0.06)', () => {
    const result = resolveAliases({
      trades: [day('2024-06-21', 'Lloyds Engineering', 1_000n, 72_500n * RUPEE)],
      statements: [day('2024-06-21', 'IRFC', 1_000n, 72_500n * RUPEE + 60_000n)],
      hints,
      known: [],
    });
    expect(result.resolved).toEqual([{ alias: 'Lloyds Engineering', isin: 'INE053F01010', source: 'join', via: 'IRFC' }]);
  });

  it('prefers an identical name only among candidates whose values agree', () => {
    const result = resolveAliases({
      trades: [day('2024-05-23', 'IRFC', 50n, 9_360n * RUPEE)],
      statements: [day('2024-05-23', 'IRFC', 50n, 9_360n * RUPEE), day('2024-05-23', 'Bharti Hexacom', 50n, 9_360n * RUPEE)],
      hints,
      known: [],
    });
    expect(result.resolved).toEqual([{ alias: 'IRFC', isin: 'INE053F01010', source: 'join', via: 'IRFC' }]);
  });
});

describe('conflicting hints', () => {
  it('never resolves through a statement name that maps to two ISINs', () => {
    const result = resolveAliases({
      trades: [day('2024-05-23', 'X', 50n, 9_360n * RUPEE)],
      statements: [day('2024-05-23', 'IRFC', 50n, 9_360n * RUPEE)],
      hints: [...hints, { name: 'IRFC', isin: 'INE000000017' }, { name: 'IRFC', isin: 'INE053F01010' }],
      known: [],
    });
    expect(result.unresolved).toEqual([{ alias: 'X', reason: 'conflicting_isin', candidates: ['IRFC'] }]);
  });
});
