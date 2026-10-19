// User actions on corporate actions (plan S10b tasks 2 and 4). A corporate action is a fact about a security, so
// every change recomputes every account, in one transaction; nothing is applied without the user's confirmation.
import { previewCorporateAction, type CorporateActionPreview } from '@bhavbook/core';
import type Database from 'better-sqlite3';
import {
  activeCorporateActions,
  createCorporateAction,
  parseCorporateAction,
  restoreCorporateAction,
  revertCorporateAction,
} from '../services/corporate-actions.js';
import { activeAdjustments } from '../services/adjustments.js';
import { brokerOf, loadFills, recompute, type RecomputeOptions } from './index.js';

function accountIds(db: Database.Database): string[] {
  return db.prepare('SELECT id FROM broker_account ORDER BY id').pluck().all() as string[];
}

function recomputeAll(db: Database.Database, options: RecomputeOptions): void {
  for (const accountId of accountIds(db)) recompute(db, accountId, options);
}

/** Stores a corporate action and recomputes every account. Returns its id. */
export function applyCorporateActionAndRecompute(
  db: Database.Database,
  input: unknown,
  options: RecomputeOptions = {},
): string {
  return db.transaction(() => {
    const id = createCorporateAction(db, input, options);
    recomputeAll(db, options);
    return id;
  })();
}

export function revertCorporateActionAndRecompute(
  db: Database.Database,
  id: string,
  options: RecomputeOptions = {},
): void {
  db.transaction(() => {
    revertCorporateAction(db, id);
    recomputeAll(db, options);
  })();
}

export function restoreCorporateActionAndRecompute(
  db: Database.Database,
  id: string,
  options: RecomputeOptions = {},
): void {
  db.transaction(() => {
    restoreCorporateAction(db, id);
    recomputeAll(db, options);
  })();
}

/**
 * What a corporate action would do across the vault (PRD §7.4 preview), from the stored state: every account's
 * affected open lots before and after, and the fractions. Stores nothing.
 */
export function previewCorporateActionInVault(db: Database.Database, input: unknown): CorporateActionPreview {
  const action = parseCorporateAction(input);
  const existing = activeCorporateActions(db);
  const previews = accountIds(db).map((accountId) =>
    previewCorporateAction(
      loadFills(db, accountId, brokerOf(db, accountId)),
      activeAdjustments(db, accountId),
      action,
      existing,
    ),
  );
  return {
    before: previews.flatMap((preview) => preview.before),
    after: previews.flatMap((preview) => preview.after),
    fractions: previews.flatMap((preview) => preview.fractions),
  };
}
