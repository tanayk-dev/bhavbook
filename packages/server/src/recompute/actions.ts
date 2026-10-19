// User actions on adjustments and their issues (plan S10a tasks 3-4). Every action stores or changes an
// adjustment and then recomputes the account; nothing is applied without the user's confirmation (ADR-0013).
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  AdjustmentError,
  createAdjustment,
  restoreAdjustment,
  revertAdjustment,
  supersedeAdjustment,
} from '../services/adjustments.js';
import { recompute, type RecomputeOptions } from './index.js';
import { FILL_FROM_STATEMENT, OPENING_LOT_REDUNDANT } from './types.js';

interface OpenIssue {
  readonly account_id: string;
  readonly kind: string;
  readonly fingerprint: string;
  readonly subject_json: string;
}

function openIssue(db: Database.Database, issueId: string, kind: string): OpenIssue {
  const issue = db
    .prepare("SELECT account_id, kind, fingerprint, subject_json FROM issue WHERE id = ? AND status = 'open'")
    .get(issueId) as OpenIssue | undefined;
  if (issue?.kind !== kind) throw new AdjustmentError('no such open issue');
  return issue;
}

const suggestionSchema = z
  .object({
    instrumentKey: z.string(),
    bucket: z.enum(['DELIVERY', 'MTF']),
    quantity: z.string(),
    totalCostMicro: z.string(),
    entryDateIst: z.string(),
    statementKey: z.string(),
  })
  .strict();

/** Stores an adjustment and recomputes its account. Returns the adjustment id. */
export function applyAdjustment(
  db: Database.Database,
  accountId: string,
  input: unknown,
  options: RecomputeOptions = {},
): string {
  return db.transaction(() => {
    const id = createAdjustment(db, accountId, input, options);
    recompute(db, accountId, options);
    return id;
  })();
}

/** "Fill from broker statement": the suggested lot becomes an opening lot with source broker_statement. */
export function acceptStatementSuggestion(
  db: Database.Database,
  issueId: string,
  options: RecomputeOptions = {},
): string {
  return db.transaction(() => {
    const issue = openIssue(db, issueId, FILL_FROM_STATEMENT);
    const suggestion = suggestionSchema.parse(JSON.parse(issue.subject_json));
    const id = createAdjustment(
      db,
      issue.account_id,
      {
        kind: 'opening_lot',
        instrumentKey: suggestion.instrumentKey,
        bucket: suggestion.bucket,
        quantity: suggestion.quantity,
        totalCostMicro: suggestion.totalCostMicro,
        entryDateIst: suggestion.entryDateIst,
      },
      { ...options, source: 'broker_statement' },
    );
    recompute(db, issue.account_id, options);
    return id;
  })();
}

/** E7 "replace the manual lot": the redundant opening lot is superseded; positions use the real fills. */
export function replaceRedundantLot(
  db: Database.Database,
  issueId: string,
  options: RecomputeOptions = {},
): void {
  db.transaction(() => {
    const issue = openIssue(db, issueId, OPENING_LOT_REDUNDANT);
    supersedeAdjustment(db, issue.fingerprint);
    recompute(db, issue.account_id, options);
  })();
}

/** active -> reverted, then recompute (a reverted opening lot makes its position INCOMPLETE again). */
export function revertAndRecompute(
  db: Database.Database,
  adjustmentId: string,
  options: RecomputeOptions = {},
): void {
  db.transaction(() => {
    recompute(db, revertAdjustment(db, adjustmentId), options);
  })();
}

/** reverted -> active, then recompute. */
export function restoreAndRecompute(
  db: Database.Database,
  adjustmentId: string,
  options: RecomputeOptions = {},
): void {
  db.transaction(() => {
    recompute(db, restoreAdjustment(db, adjustmentId), options);
  })();
}

/** Dismisses an open issue; recomputes never re-open it. */
export function dismissIssue(db: Database.Database, issueId: string): void {
  const changes = db
    .prepare("UPDATE issue SET status = 'dismissed' WHERE id = ? AND status = 'open'")
    .run(issueId).changes;
  if (changes === 0) throw new AdjustmentError('no such open issue');
}
