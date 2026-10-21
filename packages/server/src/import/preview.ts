// Preview (PRD §5.1): detect → parse → count, against the vault and the earlier files of the same preview.
// Writes nothing. Row errors are reported as line + code only (ADR-0019).
import {
  detectReport,
  parseResultSchema,
  type BrokerAdapter,
  type BrokerId,
  type ParseResult,
  type ReportKind,
  type RowError,
} from '@bhavbook/adapters';
import type Database from 'better-sqlite3';
import type { IssueForecast, IssueForecaster } from '../recompute/types.js';
import { readImportFile } from './read.js';

/** How many row errors a preview shows; the total is always in `counts.errors`. */
export const ERROR_SAMPLE = 50;
/** PRD §6.4: warn when a file overlapping the covered range shares less than this share of its keys there. */
export const WRONG_ACCOUNT_SHARE = 0.1;

export interface ImportFile {
  readonly bytes: Buffer;
  /** Shown back in the preview only; never stored (ADR-0019). */
  readonly name?: string;
  /** The person's choice when detection was ambiguous: honoured only if it is one of the tied candidates. */
  readonly kind?: ReportKind;
}

export interface PreviewCounts {
  readonly rows: { readonly new: number; readonly duplicate: number };
  readonly statements: { readonly new: number; readonly duplicate: number };
  readonly skipped: Readonly<Partial<Record<string, number>>>;
  readonly errors: number;
}

interface Labelled {
  readonly index: number;
  readonly label: string | null;
}

export type FilePreview = Labelled &
  (
    | {
        readonly status: 'ready';
        readonly broker: BrokerId;
        readonly kind: ReportKind;
        readonly counts: PreviewCounts;
        readonly errors: readonly RowError[];
        readonly coverage: ParseResult['coverage'];
        readonly warnings: readonly ('wrong_account' | 'forecast_unavailable')[];
        /** Issues the commit would create or resolve (empty when no forecaster is configured). */
        readonly issueForecast: readonly IssueForecast[];
      }
    | {
        readonly status: 'ambiguous';
        readonly candidates: readonly { broker: BrokerId; kind: ReportKind; confidence: number }[];
      }
    | {
        readonly status: 'rejected';
        readonly broker: BrokerId;
        readonly kind: ReportKind;
        readonly message: string;
      }
    | { readonly status: 'wrong_broker'; readonly broker: BrokerId; readonly kind: ReportKind }
    | { readonly status: 'unrecognised' }
    | { readonly status: 'unreadable'; readonly reason: 'too_large' | 'malformed' }
  );

/** A file that can be committed: everything commitImport needs, kept in memory only. */
export interface ParsedFile {
  readonly kind: ReportKind;
  readonly adapterVersion: string;
  readonly sha256: string;
  readonly result: ParseResult;
  readonly counts: PreviewCounts;
}

export interface PreviewContext {
  readonly db: Database.Database;
  readonly adapters: readonly BrokerAdapter[];
  readonly forecast?: IssueForecaster | undefined;
}

/** Keys already seen in this preview, so a later file's copies count as duplicates. */
export interface SeenKeys {
  readonly rows: Set<string>;
  readonly statements: Set<string>;
}

function countRows(
  db: Database.Database,
  accountId: string,
  result: ParseResult,
  seen: SeenKeys,
): PreviewCounts {
  const tradeExists = db.prepare('SELECT 1 FROM trade_row WHERE account_id = ? AND dedup_key = ?').pluck();
  const statementExists = db
    .prepare('SELECT 1 FROM statement_row WHERE account_id = ? AND kind = ? AND dedup_key = ?')
    .pluck();
  const rows = { new: 0, duplicate: 0 };
  for (const row of result.rows) {
    const duplicate = seen.rows.has(row.dedupKey) || tradeExists.get(accountId, row.dedupKey) !== undefined;
    seen.rows.add(row.dedupKey);
    rows[duplicate ? 'duplicate' : 'new'] += 1;
  }
  const statements = { new: 0, duplicate: 0 };
  for (const statement of result.statements) {
    const key = `${statement.kind}\u0000${statement.dedupKey}`;
    const duplicate =
      seen.statements.has(key) ||
      statementExists.get(accountId, statement.kind, statement.dedupKey) !== undefined;
    seen.statements.add(key);
    statements[duplicate ? 'duplicate' : 'new'] += 1;
  }
  const skipped: Partial<Record<string, number>> = {};
  for (const entry of result.skipped) skipped[entry.reason] = (skipped[entry.reason] ?? 0) + 1;
  return { rows, statements, skipped, errors: result.errors.length };
}

/**
 * PRD §6.4 wrong-account heuristic: where the file's trade dates fall inside ranges the account has already
 * imported (batch coverage, not the span of all its trades, so back-filling a gap never warns), the file should
 * mostly repeat keys the account already has. Sharing under 10% there suggests another person's file.
 */
function looksLikeAnotherAccount(db: Database.Database, accountId: string, result: ParseResult): boolean {
  if (result.rows.length === 0) return false;
  const ranges = db
    .prepare(
      `SELECT coverage_from AS lo, coverage_to AS hi FROM import_batch b
       WHERE account_id = ? AND coverage_from IS NOT NULL AND coverage_to IS NOT NULL
         AND EXISTS (SELECT 1 FROM batch_row r WHERE r.batch_id = b.id AND r.target = 'trade')`,
    )
    .all(accountId) as { lo: string; hi: string }[];
  const covered = (date: string): boolean => ranges.some((range) => date >= range.lo && date <= range.hi);
  const inOverlap = result.rows.filter((row) => covered(row.tradeDateIst));
  if (inOverlap.length === 0) return false;
  const exists = db.prepare('SELECT 1 FROM trade_row WHERE account_id = ? AND dedup_key = ?').pluck();
  const shared = inOverlap.filter((row) => exists.get(accountId, row.dedupKey) !== undefined).length;
  return shared / inOverlap.length < WRONG_ACCOUNT_SHARE;
}

/** The contract says dedup keys and raw lines are unique within a file; a result breaking that is malformed. */
function hasRepeats(result: ParseResult): boolean {
  const keys = new Set(result.rows.map((row) => row.dedupKey));
  const lines = new Set(result.rows.map((row) => row.raw.line));
  const statements = new Set(result.statements.map((row) => `${row.kind}\u0000${row.dedupKey}`));
  return (
    keys.size !== result.rows.length ||
    lines.size !== result.rows.length ||
    statements.size !== result.statements.length
  );
}

/**
 * The issue forecast, when a forecaster is configured and the file adds anything new; null when it failed (the
 * forecast is advisory, so a failure never fails the preview).
 */
function forecastFor(
  context: PreviewContext,
  accountId: string,
  result: ParseResult,
  counts: PreviewCounts,
): readonly IssueForecast[] | null {
  if (context.forecast === undefined || (counts.rows.new === 0 && counts.statements.new === 0)) return [];
  try {
    return context.forecast(accountId, result);
  } catch {
    return null;
  }
}

/** Previews one file; `parsed` is set when the file can be committed. */
export async function previewFile(
  context: PreviewContext,
  account: { readonly id: string; readonly broker: string },
  file: ImportFile,
  base: Labelled,
  seen: SeenKeys,
): Promise<{ preview: FilePreview; parsed: ParsedFile | null }> {
  const read = await readImportFile(file.bytes);
  if (!read.ok) return { preview: { ...base, status: 'unreadable', reason: read.reason }, parsed: null };
  const candidates = detectReport(context.adapters, read.probe);
  const [top] = candidates;
  if (top === undefined) return { preview: { ...base, status: 'unrecognised' }, parsed: null };
  const ties = candidates.filter((candidate) => candidate.confidence === top.confidence);
  const chosen = ties.length > 1 ? ties.find((candidate) => candidate.kind === file.kind) : top;
  if (chosen === undefined) {
    const options = ties.map(({ broker, kind, confidence }) => ({ broker, kind, confidence }));
    return { preview: { ...base, status: 'ambiguous', candidates: options }, parsed: null };
  }
  if (chosen.rejected !== undefined) {
    const preview = {
      ...base,
      status: 'rejected',
      broker: chosen.broker,
      kind: chosen.kind,
      message: chosen.rejected,
    } as const;
    return { preview, parsed: null };
  }
  if (chosen.broker !== account.broker) {
    return {
      preview: { ...base, status: 'wrong_broker', broker: chosen.broker, kind: chosen.kind },
      parsed: null,
    };
  }
  const adapter = context.adapters.find((candidate) => candidate.broker === chosen.broker);
  if (adapter === undefined) throw new Error('detected broker has no adapter');
  let result: ParseResult;
  try {
    // Adapters are ours, but their output still crosses a boundary into the vault: check it against the contract.
    result = parseResultSchema.parse(adapter.parse(read.input, chosen.kind));
  } catch {
    return { preview: { ...base, status: 'unreadable', reason: 'malformed' }, parsed: null };
  }
  if (hasRepeats(result)) {
    return { preview: { ...base, status: 'unreadable', reason: 'malformed' }, parsed: null };
  }
  const counts = countRows(context.db, account.id, result, seen);
  const forecast = forecastFor(context, account.id, result, counts);
  const warnings = [
    ...(looksLikeAnotherAccount(context.db, account.id, result) ? (['wrong_account'] as const) : []),
    ...(forecast === null ? (['forecast_unavailable'] as const) : []),
  ];
  const preview: FilePreview = {
    ...base,
    status: 'ready',
    broker: chosen.broker,
    kind: chosen.kind,
    counts,
    errors: result.errors.slice(0, ERROR_SAMPLE),
    coverage: result.coverage,
    warnings,
    issueForecast: forecast ?? [],
  };
  const parsed = {
    kind: chosen.kind,
    adapterVersion: adapter.version,
    sha256: read.sha256,
    result,
    counts,
  };
  return { preview, parsed };
}
