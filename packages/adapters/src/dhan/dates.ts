// Dhan writes dates three ways: ISO (trade history), `22 Apr 2024[ 00:00:00]` (Journal CSVs) and `18-09-2024`
// (Tax Report, report titles). All of them are IST calendar dates; each helper returns ISO or null.
import { istDayBounds } from '@bhavbook/core';

const MONTHS: ReadonlyMap<string, string> = new Map([
  ['jan', '01'],
  ['feb', '02'],
  ['mar', '03'],
  ['apr', '04'],
  ['may', '05'],
  ['jun', '06'],
  ['jul', '07'],
  ['aug', '08'],
  ['sep', '09'],
  ['oct', '10'],
  ['nov', '11'],
  ['dec', '12'],
]);

/** `YYYY-MM-DD` when it is a real calendar date, else null. */
export function validIsoDate(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  try {
    istDayBounds(date);
    return date;
  } catch {
    return null;
  }
}

/** `22 Apr 2024` or `22 Apr 2024 00:00:00`. */
export function fromDayMonthName(text: string): string | null {
  const match = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})(?: \d{2}:\d{2}:\d{2})?$/.exec(text.trim());
  if (!match) return null;
  const [, day = '', name = '', year = ''] = match;
  const month = MONTHS.get(name.toLowerCase());
  return month === undefined ? null : validIsoDate(`${year}-${month}-${day.padStart(2, '0')}`);
}

/** `18-09-2024`. */
export function fromDayMonthYear(text: string): string | null {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const [, day = '', month = '', year = ''] = match;
  return validIsoDate(`${year}-${month}-${day}`);
}

/** The period in a title such as `From 01-04-2024 to 31-03-2025`. */
export function periodOf(text: string): { from: string; to: string } | null {
  const match = /from (\d{2}-\d{2}-\d{4}) to (\d{2}-\d{2}-\d{4})/i.exec(text);
  if (!match) return null;
  const from = fromDayMonthYear(match[1] ?? '');
  const to = fromDayMonthYear(match[2] ?? '');
  return from && to ? { from, to } : null;
}
