// Dates on screen (PRD §12, direction §4.3): `dd MMM yyyy`. IST calendar dates arrive as `YYYY-MM-DD` and are
// formatted as text, never through the machine's timezone.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function formatIstDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = match === null ? undefined : MONTHS[Number.parseInt(match[2] ?? '', 10) - 1];
  if (match === null || month === undefined) return date;
  return `${match[3] ?? ''} ${month} ${match[1] ?? ''}`;
}
