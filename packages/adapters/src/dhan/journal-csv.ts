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
  readonly coverage: { from: string; to: string } | null;
}

/** The title cell of the first line, e.g. `Global transction report` (Dhan's spelling). */
export function journalTitle(head: string): string {
  return (head.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '').split(',', 1)[0]?.trim() ?? '';
}

function summaryOf(record: readonly string[] | undefined): Record<string, string> {
  const summary: Record<string, string> = {};
  if (!record || record[0]?.startsWith('NOTE')) return summary;
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

  const rows: JournalRow[] = [];
  let index = headerAt + 1;
  for (; index < records.length; index += 1) {
    const entry = records[index];
    if (!entry || isBlankRecord(entry.record)) break;
    const fields = Object.fromEntries(
      header.map((name, column) => [name, entry.record[column]?.trim() ?? '']),
    );
    rows.push({ line: entry.line, fields, raw: entry.raw });
  }
  const summaryRecord = records.slice(index).find((entry) => !isBlankRecord(entry.record))?.record;
  const [title] = records;
  return {
    rows,
    summary: summaryOf(summaryRecord),
    coverage: title ? periodOf(title.record.join(',')) : null,
  };
}
