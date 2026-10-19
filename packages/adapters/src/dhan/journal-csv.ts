// Dhan "Journal" CSVs (Global Transactions, DP Charges, P&L, Ledger, ...) share one layout (NOTES.md):
//   title,From DD-MM-YYYY to DD-MM-YYYY
//   Name / UCC / Mobile / Email ID lines      <- personal data: never read past, never returned
//   (blank)
//   header, data rows
//   (blank)
//   summary pairs (Net P&L,-7219.12,...), NOTE line
import { isBlankRecord, readCsvRecords } from '../csv.js';
import { periodOf } from './dates.js';

export interface JournalRow {
  readonly line: number;
  readonly fields: Readonly<Record<string, string>>;
  readonly raw: string;
}

export interface JournalCsv {
  readonly rows: readonly JournalRow[];
  readonly summary: Readonly<Record<string, string>>;
  /** Lines after the header that are neither data rows, the summary nor the NOTE line: callers report them. */
  readonly unexpected: readonly number[];
  readonly coverage: { from: string; to: string } | null;
}

/** The title cell of the first line, e.g. `Global transction report` (Dhan's spelling). */
export function journalTitle(head: string): string {
  return (head.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '').split(',', 1)[0]?.trim() ?? '';
}

function summaryOf(record: readonly string[] | undefined): Record<string, string> {
  const summary: Record<string, string> = {};
  if (!record) return summary;
  for (let index = 0; index + 1 < record.length; index += 2) {
    const label = record[index]?.trim() ?? '';
    if (label !== '' && !Object.hasOwn(summary, label)) summary[label] = record[index + 1]?.trim() ?? '';
  }
  return summary;
}

/** Reads the table whose header contains every `required` column; throws when there is none. */
export function readJournalCsv(text: string, required: readonly string[]): JournalCsv {
  const records = readCsvRecords(text);
  const headerAt = records.findIndex((entry) => required.every((name) => entry.record.includes(name)));
  const header = records[headerAt]?.record;
  if (!header) throw new Error('not a Dhan report (expected header not found)');

  // Data rows have the header's width; the summary pairs line (the last other line) and the NOTE line don't.
  // Blank lines never end the table, so a stray one can't hide the rows after it.
  const rows: JournalRow[] = [];
  const others: { line: number; record: readonly string[] }[] = [];
  for (const entry of records.slice(headerAt + 1)) {
    if (isBlankRecord(entry.record) || entry.record[0]?.trim().startsWith('NOTE')) continue;
    if (entry.record.length !== header.length) {
      others.push(entry);
      continue;
    }
    const fields = Object.fromEntries(
      header.map((name, column) => [name, entry.record[column]?.trim() ?? '']),
    );
    rows.push({ line: entry.line, fields, raw: entry.raw });
  }
  const summaryRecord = others.at(-1)?.record;
  const [title] = records;
  return {
    rows,
    summary: summaryOf(summaryRecord),
    unexpected: others.slice(0, -1).map((entry) => entry.line),
    coverage: title ? periodOf(title.record.join(',')) : null,
  };
}
