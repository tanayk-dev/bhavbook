// The issues inbox (S13c, PRD §4): every issue a recompute or an import raised, with what the UI needs to show and
// act on it. Subjects are stored JSON, returned parsed; they hold instrument keys, dates and amounts, never personal
// data (ADR-0019). Dismissing is the user's acknowledgement (a recompute never re-opens it); reopening undoes that.
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { recomputeBroker, type RecomputeOptions } from '../recompute/index.js';
import { AdjustmentError } from './adjustments.js';
import {
  InstrumentError,
  mapInstrumentManually,
  suggestForAlias,
  UNRESOLVED_INSTRUMENT,
  type InstrumentSuggestion,
  type ManualTarget,
} from './instruments.js';

export const ISSUE_STATUSES = ['open', 'dismissed', 'resolved'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const issueFilterSchema = z
  .object({
    status: z.enum(ISSUE_STATUSES).optional(),
    kind: z
      .string()
      .regex(/^[a-z_]{1,64}$/)
      .optional(),
    accountId: z.string().min(1).max(64).optional(),
  })
  .strict();
export type IssueFilter = z.infer<typeof issueFilterSchema>;

export interface IssueView {
  readonly id: string;
  readonly kind: string;
  readonly status: IssueStatus;
  readonly accountId: string | null;
  readonly accountNickname: string | null;
  readonly broker: string | null;
  /** The stored subject, parsed; null when it can't be read. */
  readonly subject: unknown;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

interface IssueRow {
  readonly id: string;
  readonly kind: string;
  readonly status: IssueStatus;
  readonly account_id: string | null;
  readonly nickname: string | null;
  readonly broker: string | null;
  readonly subject_json: string;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

function parseSubject(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Issues matching the filter (open by default), newest first. */
export function listIssues(db: Database.Database, filter: IssueFilter = {}): IssueView[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.kind, i.status, i.account_id, a.nickname, a.broker, i.subject_json, i.created_at, i.resolved_at
       FROM issue i LEFT JOIN broker_account a ON a.id = i.account_id
       WHERE i.status = ? AND (? IS NULL OR i.kind = ?) AND (? IS NULL OR i.account_id = ?)
       ORDER BY i.created_at DESC, i.id`,
    )
    .all(
      filter.status ?? 'open',
      filter.kind ?? null,
      filter.kind ?? null,
      filter.accountId ?? null,
      filter.accountId ?? null,
    ) as IssueRow[];
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    accountId: row.account_id,
    accountNickname: row.nickname,
    broker: row.broker,
    subject: parseSubject(row.subject_json),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }));
}

/** Open issues per kind, for the navigation badge and the inbox filters. */
export function issueSummary(db: Database.Database): { open: number; byKind: Record<string, number> } {
  const rows = db
    .prepare("SELECT kind, count(*) AS n FROM issue WHERE status = 'open' GROUP BY kind ORDER BY kind")
    .all() as { kind: string; n: bigint }[];
  const byKind = Object.fromEntries(rows.map((row) => [row.kind, Number(row.n)]));
  return { open: rows.reduce((sum, row) => sum + Number(row.n), 0), byKind };
}

/**
 * Readable names for instrument keys: an ISIN's instrument name, a manual instrument's name, and a broker-local
 * key's alias (`local:dhan:REC` → "REC"). Keys with no name are left out (the UI shows the key).
 */
export function instrumentNames(db: Database.Database, keys: readonly string[]): Record<string, string> {
  const byIsin = db.prepare('SELECT display_name FROM instrument WHERE isin = ?').pluck();
  const byId = db.prepare('SELECT display_name FROM instrument WHERE id = ?').pluck();
  const names: Record<string, string> = {};
  for (const key of new Set(keys)) {
    const local = /^local:[a-z]+:(.+)$/.exec(key);
    const name: unknown = local
      ? local[1]
      : key.startsWith('ins:')
        ? byId.get(key.slice(4))
        : byIsin.get(key);
    if (typeof name === 'string' && name !== '') names[key] = name;
  }
  return names;
}

/** A dismissed issue back to open (the user changed their mind); a recompute may then resolve it. */
export function reopenIssue(db: Database.Database, issueId: string): void {
  const changes = db
    .prepare("UPDATE issue SET status = 'open' WHERE id = ? AND status = 'dismissed'")
    .run(issueId).changes;
  if (changes === 0) throw new AdjustmentError('no such dismissed issue', { code: 'not_found' });
}

const aliasSubjectSchema = z.object({ broker: z.string().min(1), alias: z.string().min(1) });

/** The broker and alias an open `unresolved_instrument` issue is about. */
function aliasOfIssue(db: Database.Database, issueId: string): { broker: string; alias: string } {
  const subject: unknown = db
    .prepare("SELECT subject_json FROM issue WHERE id = ? AND kind = ? AND status = 'open'")
    .pluck()
    .get(issueId, UNRESOLVED_INSTRUMENT);
  const parsed = aliasSubjectSchema.safeParse(typeof subject === 'string' ? parseSubject(subject) : null);
  if (!parsed.success) throw new InstrumentError('no such open issue', { code: 'not_found' });
  return parsed.data;
}

export function suggestionsForIssue(db: Database.Database, issueId: string): InstrumentSuggestion[] {
  return suggestForAlias(db, aliasOfIssue(db, issueId));
}

export const mapInstrumentSchema = z.union([
  z.object({ isin: z.string().max(12), displayName: z.string().min(1).max(80).optional() }).strict(),
  z.object({ newDisplayName: z.string().min(1).max(80) }).strict(),
]);

/**
 * Maps an unresolved alias to an instrument (an ISIN, or a new instrument without one), then recomputes every
 * account of that broker: aliases are per broker, so the mapping can re-key them all (S8).
 */
export function mapIssueInstrument(
  db: Database.Database,
  issueId: string,
  input: z.infer<typeof mapInstrumentSchema>,
  options: RecomputeOptions = {},
): void {
  db.transaction(() => {
    const issue = db.prepare('SELECT account_id FROM issue WHERE id = ?').pluck().get(issueId);
    const ref = aliasOfIssue(db, issueId);
    // Zod leaves an absent optional as `undefined`; the mapping wants it absent.
    const target: ManualTarget =
      'isin' in input
        ? input.displayName === undefined
          ? { isin: input.isin }
          : { isin: input.isin, displayName: input.displayName }
        : input;
    mapInstrumentManually(db, ref, target, options);
    if (typeof issue === 'string') recomputeBroker(db, issue, options);
  })();
}
