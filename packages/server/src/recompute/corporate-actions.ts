// User actions on corporate actions (plan S10b tasks 2 and 4). A corporate action is a fact about a security, so
// every change recomputes every account in one transaction: if any account fails, nothing changes, and the error
// names that account (by id only, ADR-0019). Nothing is applied without the user's confirmation.
import type Database from 'better-sqlite3';
import {
  CorporateActionError,
  createCorporateAction,
  restoreCorporateAction,
  revertCorporateAction,
} from '../services/corporate-actions.js';
import { recompute, type RecomputeOptions } from './index.js';

export { previewCorporateActionInVault } from './index.js';

function recomputeAll(db: Database.Database, options: RecomputeOptions): void {
  const accounts = db.prepare('SELECT id FROM broker_account ORDER BY id').pluck().all();
  for (const accountId of accounts) {
    if (typeof accountId !== 'string') throw new CorporateActionError('an account id is unreadable');
    try {
      recompute(db, accountId, options);
    } catch (error) {
      if (error instanceof CorporateActionError && error.corporateActionId !== undefined) throw error;
      throw new CorporateActionError('an account could not be recomputed', { accountId });
    }
  }
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
