// Shared CSV reading. csv-parse quotes cell content in its error messages, so every failure becomes one fixed
// message with no cause attached: file text can never escape through an exception (ADR-0019).
import { parse } from 'csv-parse/sync';

export interface CsvRecord {
  readonly record: readonly string[];
  /** 1-based file line on which the record ends. */
  readonly line: number;
  readonly raw: string;
}

export const MALFORMED_CSV = 'malformed CSV';

/** Every record, blank lines included (as all-empty records), so callers can use them as section breaks. */
export function readCsvRecords(text: string): CsvRecord[] {
  let parsed: unknown;
  try {
    parsed = parse(text, { bom: true, relax_column_count: true, info: true, raw: true });
  } catch {
    throw new Error(MALFORMED_CSV);
  }
  if (!Array.isArray(parsed)) throw new Error(MALFORMED_CSV);
  return parsed.map((entry: unknown) => {
    const value = entry as { record?: unknown; info?: { lines?: unknown }; raw?: unknown };
    if (
      !Array.isArray(value.record) ||
      typeof value.info?.lines !== 'number' ||
      typeof value.raw !== 'string'
    ) {
      throw new Error(MALFORMED_CSV);
    }
    return {
      record: value.record.map(String),
      line: value.info.lines,
      raw: value.raw.replace(/\r?\n?$/, ''),
    };
  });
}

export function isBlankRecord(record: readonly string[]): boolean {
  return record.every((cell) => cell.trim() === '');
}
