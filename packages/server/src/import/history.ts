// Import history (PRD §5.1): an account's committed batches, newest first, with what each commit did. Undoing one
// removes it from this list. A batch records no file name, only its report kind, range and counts (ADR-0019).
import type Database from 'better-sqlite3';
import type { PreviewCounts } from './preview.js';

export interface ImportRecord {
  readonly id: string;
  readonly kind: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly counts: PreviewCounts;
  /** UTC, ISO-8601. */
  readonly createdAt: string;
}

interface BatchRow {
  readonly id: string;
  readonly kind: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly counts_json: string;
  readonly created_at: string;
}

const EMPTY: PreviewCounts = {
  rows: { new: 0, duplicate: 0 },
  statements: { new: 0, duplicate: 0 },
  skipped: {},
  errors: 0,
};

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

function pair(value: unknown): { new: number; duplicate: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { new: fresh, duplicate } = value as Record<string, unknown>;
  return isCount(fresh) && isCount(duplicate) ? { new: fresh, duplicate } : null;
}

/** A stored counts blob, checked field by field; zeros when it is unreadable (it is display-only). */
function counts(json: string): PreviewCounts {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return EMPTY;
  }
  if (typeof value !== 'object' || value === null) return EMPTY;
  const stored = value as Record<string, unknown>;
  const rows = pair(stored.rows);
  const statements = pair(stored.statements);
  if (rows === null || statements === null) return EMPTY;
  const skipped: Record<string, number> = {};
  if (typeof stored.skipped === 'object' && stored.skipped !== null) {
    for (const [reason, n] of Object.entries(stored.skipped)) if (isCount(n)) skipped[reason] = n;
  }
  return { rows, statements, skipped, errors: isCount(stored.errors) ? stored.errors : 0 };
}

export function listImports(db: Database.Database, accountId: string): ImportRecord[] {
  const rows = db
    .prepare(
      `SELECT id, report_kind AS kind, coverage_from AS "from", coverage_to AS "to", counts_json, created_at
       FROM import_batch WHERE account_id = ?
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(accountId) as BatchRow[];
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    from: row.from,
    to: row.to,
    counts: counts(row.counts_json),
    createdAt: row.created_at,
  }));
}
