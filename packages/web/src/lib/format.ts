// Dates on screen (PRD §12, direction §4.3): `dd MMM yyyy`. IST calendar dates arrive as `YYYY-MM-DD` and are
// formatted as text, never through the machine's timezone.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** A UTC instant as `dd MMM yyyy, HH:mm IST`, computed from the fixed IST offset (never the machine's zone). */
export function formatIstDateTime(iso: string): string {
  const millis = Date.parse(iso);
  if (Number.isNaN(millis)) return iso;
  const ist = new Date(millis + IST_OFFSET_MS).toISOString();
  return `${formatIstDate(ist.slice(0, 10))}, ${ist.slice(11, 16)} IST`;
}

/** A UTC instant's IST calendar date, `YYYY-MM-DD` (an instant at 00:30 IST is that IST day, not the UTC one). */
export function istDateOf(iso: string): string {
  const millis = Date.parse(iso);
  if (Number.isNaN(millis)) return iso.slice(0, 10);
  return new Date(millis + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function formatIstDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = match === null ? undefined : MONTHS[Number.parseInt(match[2] ?? '', 10) - 1];
  if (match === null || month === undefined) return date;
  return `${match[3] ?? ''} ${month} ${match[1] ?? ''}`;
}
