// Undo (PRD §5.1): delete exactly one batch's rows. trade_row / statement_row keep one row per dedup key, owned
// by the first batch that brought it, so a later batch may contain rows the undone batch owned. Those are
// re-inserted, in the same transaction, from the earliest surviving batch's own copy (`batch_row`, schema 0002;
// "earliest" is insertion order, i.e. the lowest batch_row id). The result equals importing the remaining batches
// in order.
import type Database from 'better-sqlite3';
import { ImportError } from './errors.js';
import { decodeStatementPayload, decodeTradePayload } from './payload.js';
import { INSERT_STATEMENT_SQL, INSERT_TRADE_SQL, tradeParams } from './rows.js';

export interface UndoResult {
  readonly accountId: string;
  /** Net rows that left the account (rows another batch also had are kept). */
  readonly removed: { readonly rows: number; readonly statements: number };
}

interface Successor {
  readonly batch_id: string;
  readonly payload_json: string;
}

/** Finds the batch that should own a key once `batchId` is gone. Call inside a transaction, after deleting it. */
function successorQuery(db: Database.Database): Database.Statement {
  return db.prepare(
    `SELECT r.batch_id, r.payload_json FROM batch_row r JOIN import_batch b ON b.id = r.batch_id
     WHERE b.account_id = ? AND r.target = ? AND r.kind = ? AND r.dedup_key = ?
     ORDER BY r.id LIMIT 1`,
  );
}

function reinsertTrades(db: Database.Database, accountId: string, keys: readonly string[]): number {
  const successor = successorQuery(db);
  const rawRow = db.prepare('SELECT id FROM raw_row WHERE batch_id = ? AND line_no = ?').pluck();
  const insert = db.prepare(INSERT_TRADE_SQL);
  let reinserted = 0;
  for (const key of keys) {
    const next = successor.get(accountId, 'trade', '', key) as Successor | undefined;
    if (next === undefined) continue;
    const payload = decodeTradePayload(next.payload_json);
    const rawRowId: unknown = rawRow.get(next.batch_id, payload.raw.line);
    if (rawRowId === undefined) throw new ImportError('a surviving batch is missing its raw row');
    reinserted += insert.run(tradeParams(accountId, next.batch_id, rawRowId, payload)).changes;
  }
  return reinserted;
}

function reinsertStatements(
  db: Database.Database,
  accountId: string,
  keys: readonly { kind: string; dedup_key: string }[],
): number {
  const successor = successorQuery(db);
  const insert = db.prepare(INSERT_STATEMENT_SQL);
  let reinserted = 0;
  for (const { kind, dedup_key: key } of keys) {
    const next = successor.get(accountId, 'statement', kind, key) as Successor | undefined;
    if (next === undefined) continue;
    const payload = decodeStatementPayload(next.payload_json);
    const keyJson = JSON.stringify(payload.key);
    reinserted += insert.run(accountId, next.batch_id, kind, key, keyJson, payload.dataJson).changes;
  }
  return reinserted;
}

/** Removes one batch. Call inside a transaction. */
export function removeBatch(db: Database.Database, batchId: string): UndoResult {
  const accountId = db.prepare('SELECT account_id FROM import_batch WHERE id = ?').pluck().get(batchId) as
    string | undefined;
  if (accountId === undefined) throw new ImportError('unknown import batch');
  const tradeKeys = db
    .prepare('SELECT dedup_key FROM trade_row WHERE batch_id = ?')
    .pluck()
    .all(batchId) as string[];
  const statementKeys = db
    .prepare('SELECT kind, dedup_key FROM statement_row WHERE batch_id = ?')
    .all(batchId) as { kind: string; dedup_key: string }[];
  db.prepare('DELETE FROM trade_row WHERE batch_id = ?').run(batchId);
  db.prepare('DELETE FROM statement_row WHERE batch_id = ?').run(batchId);
  // Cascades to the batch's raw_row and batch_row rows.
  db.prepare('DELETE FROM import_batch WHERE id = ?').run(batchId);
  const rows = tradeKeys.length - reinsertTrades(db, accountId, tradeKeys);
  const statements = statementKeys.length - reinsertStatements(db, accountId, statementKeys);
  return { accountId, removed: { rows, statements } };
}
