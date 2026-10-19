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

export function mergeRanges(ranges: readonly DateRange[]): DateRange[] {
  const sorted = [...ranges].sort((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from),
  );
  return sorted.reduce<DateRange[]>((merged, range) => {
    const last = merged.at(-1);
    if (last !== undefined && range.from <= shiftDays(last.to, 1)) {
      return [...merged.slice(0, -1), { from: last.from, to: range.to > last.to ? range.to : last.to }];
    }
    return [...merged, range];
  }, []);
}

export function gapsBetween(ranges: readonly DateRange[]): DateRange[] {
  return ranges.slice(1).map((range, index) => ({
    from: shiftDays(ranges[index]?.to ?? range.from, 1),
    to: shiftDays(range.from, -1),
  }));
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
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, ranges]) => {
      const merged = mergeRanges(ranges);
      return { kind, ranges: merged, gaps: gapsBetween(merged) };
    });
}
