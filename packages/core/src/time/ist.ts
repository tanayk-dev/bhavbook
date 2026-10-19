// IST (Asia/Kolkata) date logic with a fixed +05:30 offset; India has no DST (ADR-0005).
// Only Date's UTC methods are used, so results never depend on the machine timezone.
import { InvalidArgumentError, ParseError } from '../errors.js';

/** Calendar date `YYYY-MM-DD` in IST. */
export type IstDate = string;
/** UTC instant `YYYY-MM-DDTHH:MM:SSZ`. */
export type UtcIso = string;

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?$/;
const UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

interface Parts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function toInt(digits: string | undefined): number {
  return digits === undefined ? 0 : Number.parseInt(digits, 10);
}

/** Epoch milliseconds for wall-clock `parts` read as UTC, or a ParseError if the fields don't exist. */
function wallClockMs(parts: Parts): number {
  const { year, month, day, hour, minute, second } = parts;
  if (hour > 23 || minute > 59 || second > 59) throw new ParseError('time of day out of range');
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new ParseError('calendar date does not exist');
  }
  return ms;
}

function partsOf(match: RegExpExecArray): Parts {
  return {
    year: toInt(match[1]),
    month: toInt(match[2]),
    day: toInt(match[3]),
    hour: toInt(match[4]),
    minute: toInt(match[5]),
    second: toInt(match[6]),
  };
}

function toUtcIso(ms: number): UtcIso {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

function istDateMs(date: IstDate): number {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new ParseError('expected a YYYY-MM-DD date');
  return wallClockMs(partsOf(match));
}

/** Interprets a broker timestamp without zone (`YYYY-MM-DD[T| ]HH:MM:SS` or a bare date) as IST. */
export function parseIstLocal(text: string): UtcIso {
  const match = LOCAL_PATTERN.exec(text);
  if (!match) throw new ParseError('expected YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS');
  return toUtcIso(wallClockMs(partsOf(match)) - IST_OFFSET_MS);
}

/** The IST calendar date of a UTC instant. */
export function istDateOf(utcIso: UtcIso): IstDate {
  const match = UTC_PATTERN.exec(utcIso);
  if (!match) throw new ParseError('expected a UTC ISO-8601 instant ending in Z');
  const ms = wallClockMs(partsOf(match));
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC bounds of an IST day: `startUtc` inclusive, `endUtc` exclusive. */
export function istDayBounds(date: IstDate): Readonly<{ startUtc: UtcIso; endUtc: UtcIso }> {
  const startMs = istDateMs(date) - IST_OFFSET_MS;
  return { startUtc: toUtcIso(startMs), endUtc: toUtcIso(startMs + DAY_MS) };
}

/** Whole calendar days from `entry` to `exit` (both IST dates). Same day is 0. */
export function holdingDays(entry: IstDate, exit: IstDate): number {
  const days = (istDateMs(exit) - istDateMs(entry)) / DAY_MS;
  if (days < 0) throw new InvalidArgumentError('exit date is before entry date');
  return days;
}

/** Display format `dd MMM yyyy`, e.g. `12 Sep 2025`. */
export function formatIstDate(date: IstDate): string {
  const parsed = new Date(istDateMs(date));
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  const month = MONTHS[parsed.getUTCMonth()];
  if (month === undefined) throw new ParseError('month out of range');
  return `${day} ${month} ${parsed.getUTCFullYear()}`;
}
