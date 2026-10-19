// Coverage (PRD §5.1, D11): per report kind, the date ranges the account's imports cover, merged, and the gaps
// between them. Ranges that overlap or touch (one ends the day before the next starts) are joined.
import type Database from 'better-sqlite3';

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export interface KindCoverage {
  readonly kind: string;
  readonly ranges: readonly DateRange[];
  readonly gaps: readonly DateRange[];
}

const DAY_MS = 86_400_000;

/** Calendar-date arithmetic on `YYYY-MM-DD` (UTC midnight, so no time zone is involved). */
function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** ISO dates and report kinds compare correctly as plain strings. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function mergeRanges(ranges: readonly DateRange[]): DateRange[] {
  const sorted = [...ranges].sort((a, b) =>
    a.from === b.from ? compare(a.to, b.to) : compare(a.from, b.from),
  );
  return sorted.reduce<DateRange[]>((merged, range) => {
    const last = merged.at(-1);
    if (last !== undefined && range.from <= shiftDays(last.to, 1)) {
      return [...merged.slice(0, -1), { from: last.from, to: range.to > last.to ? range.to : last.to }];
    }
    return [...merged, range];
  }, []);
}

/**
 * Calendar days between consecutive merged ranges. Weekends and exchange holidays count as gaps here: there is no
 * holiday calendar in v1, so the coverage view labels a gap and the user judges whether trades are missing.
 */
export function gapsBetween(ranges: readonly DateRange[]): DateRange[] {
  const gaps: DateRange[] = [];
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (previous === undefined || current === undefined) throw new Error('unreachable: index within bounds');
    gaps.push({ from: shiftDays(previous.to, 1), to: shiftDays(current.from, -1) });
  }
  return gaps;
}

export function accountCoverage(db: Database.Database, accountId: string): KindCoverage[] {
  const rows = db
    .prepare(
      `SELECT report_kind AS kind, coverage_from AS "from", coverage_to AS "to" FROM import_batch
       WHERE account_id = ? AND coverage_from IS NOT NULL AND coverage_to IS NOT NULL`,
    )
    .all(accountId) as { kind: string; from: string; to: string }[];
  const byKind = new Map<string, DateRange[]>();
  for (const { kind, from, to } of rows) byKind.set(kind, [...(byKind.get(kind) ?? []), { from, to }]);
  return [...byKind.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([kind, ranges]) => {
      const merged = mergeRanges(ranges);
      return { kind, ranges: merged, gaps: gapsBetween(merged) };
    });
}
