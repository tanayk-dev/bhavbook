// coverage(accountId): merged covered ranges per report kind, plus the gaps between them.
import { describe, expect, it } from 'vitest';
import { ImportError } from '../../src/import/index.js';
import { DHAN, dhanDays, fixtureBytes, fixtureFile, importFiles, withVault } from './helpers.js';

/** First and last trade date of the Dhan fixture rows that pass `filter`. */
function datesOf(filter: (date: string) => boolean): { from: string; to: string } {
  const dates = fixtureBytes('dhan', 'trade_history')
    .toString('utf8')
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((row) => row.slice(0, 10))
    .filter(filter)
    .sort();
  return { from: dates[0] ?? '', to: dates.at(-1) ?? '' };
}

function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function dayAfter(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

describe('coverage', () => {
  it('merges ranges per report kind and reports the gaps between them', async () => {
    await withVault(async ({ service }) => {
      const early = (date: string): boolean => date <= '2024-06-30';
      const late = (date: string): boolean => date >= '2025-01-01';
      await importFiles(service, DHAN, [dhanDays(early)]);
      await importFiles(service, DHAN, [dhanDays(late)]);
      await importFiles(service, DHAN, [dhanDays(early)]);
      await importFiles(service, DHAN, [fixtureFile('dhan', 'global_transactions')]);
      const first = datesOf(early);
      const second = datesOf(late);
      expect(service.coverage(DHAN)).toEqual([
        {
          kind: 'dhan.global_transactions',
          ranges: [{ from: '2024-04-01', to: '2025-03-31' }],
          gaps: [],
        },
        {
          kind: 'dhan.trade_history',
          ranges: [first, second],
          gaps: [{ from: dayAfter(first.to), to: dayBefore(second.from) }],
        },
      ]);
    });
  });

  it('joins overlapping and back-to-back ranges', async () => {
    await withVault(async ({ service }) => {
      const all = datesOf(() => true);
      await importFiles(service, DHAN, [dhanDays((date) => date <= '2024-09-18')]);
      await importFiles(service, DHAN, [dhanDays((date) => date >= '2024-09-19' && date <= '2025-03-31')]);
      await importFiles(service, DHAN, [dhanDays((date) => date >= '2025-01-01')]);
      const [entry] = service.coverage(DHAN);
      // Back-to-back only when the first file's last trade day is the day before the second's first.
      const firstTo = datesOf((date) => date <= '2024-09-18').to;
      const secondFrom = datesOf((date) => date >= '2024-09-19').from;
      const expectedRanges =
        dayAfter(firstTo) === secondFrom
          ? [all]
          : [
              { from: all.from, to: firstTo },
              { from: secondFrom, to: all.to },
            ];
      expect(entry?.ranges).toEqual(expectedRanges);
    });
  });

  it('is empty for an account with no imports and rejects unknown accounts', async () => {
    await withVault(({ service }) => {
      expect(service.coverage(DHAN)).toEqual([]);
      expect(() => service.coverage('nope')).toThrow(ImportError);
    });
  });
});
