// Labels and spans shared by the charts and their tables: pure, so they are tested without a browser, and kept apart
// from the charts (which load lazily with ECharts).
import { formatINR } from '@bhavbook/core/money';
import type { Day } from '@/lib/analytics';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MINUS = '−';
const DAY_MS = 86_400_000;

/** "2025-09" as "Sep 2025". */
export const monthLabel = (month: string): string => {
  const [year = '', number = '1'] = month.split('-');
  return `${MONTHS[Number.parseInt(number, 10) - 1] ?? month} ${year}`;
};

/** A signed amount with its glyph, as Money shows it ("▲ +₹1,240.50", "▼ −₹312.40"). */
export const signed = (micro: bigint): string =>
  micro > 0n ? `▲ +${formatINR(micro)}` : micro < 0n ? `▼ ${MINUS}${formatINR(-micro)}` : formatINR(0n);

/** An axis tick in whole rupees, the sign first ("−₹5,000"). */
export const axisRupees = (value: number): string =>
  `${value < 0 ? MINUS : ''}₹${Math.abs(Math.round(value)).toLocaleString('en-IN')}`;

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The calendar rows for a span of days: from the first to the last, at most a year per row (an April-to-March
 * financial year is one row, not two half-empty calendar years).
 */
export function calendarWindows(days: readonly Day[]): [string, string][] {
  const [first] = days;
  const last = days.at(-1);
  if (first === undefined || last === undefined) return [];
  const windows: [string, string][] = [];
  let start = Date.parse(`${first.date}T00:00:00Z`);
  const end = Date.parse(`${last.date}T00:00:00Z`);
  while (start <= end) {
    const next = new Date(start);
    next.setUTCFullYear(next.getUTCFullYear() + 1);
    const stop = Math.min(end, next.getTime() - DAY_MS);
    windows.push([isoDay(start), isoDay(stop)]);
    start = stop + DAY_MS;
  }
  return windows;
}
