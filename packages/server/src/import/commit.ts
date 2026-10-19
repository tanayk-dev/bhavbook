// Commit (PRD §5.1): one transaction per commit. Every batch keeps its raw rows (ADR-0007) and its own canonical
// copy of each row (`batch_row`, schema 0002); trade_row/statement_row keep the first batch's row per dedup key
// (ADR-0009), so re-imports insert nothing.
import { randomUUID } from 'node:crypto';
import type { CanonicalRow, StatementRow } from '@bhavbook/adapters';
import type Database from 'better-sqlite3';
import { toJson } from '../http/json.js';
import { encodeStatementPayload, encodeTradePayload } from './payload.js';
import type { ParsedFile, PreviewCounts } from './preview.js';
import { INSERT_STATEMENT_SQL, INSERT_TRADE_SQL, tradeParams } from './rows.js';

export interface CommittedBatch {
  readonly batchId: string;
  readonly kind: string;
  readonly inserted: { readonly rows: number; readonly statements: number };
}

interface Statements {
  readonly batch: Database.Statement;
  readonly counts: Database.Statement;
  readonly raw: Database.Statement;
  readonly copy: Database.Statement;
  readonly trade: Database.Statement;
  readonly statement: Database.Statement;
}

function prepare(db: Database.Database): Statements {
  return {
    batch: db.prepare(
      `INSERT INTO import_batch (id, account_id, file_sha256, report_kind, adapter_version, coverage_from,
         coverage_to, counts_json, status, created_at)
       VALUES (@id, @accountId, @sha256, @kind, @adapterVersion, @from, @to, @counts, 'committed', @createdAt)`,
    ),
    counts: db.prepare('UPDATE import_batch SET counts_json = ? WHERE id = ?'),
    raw: db
      .prepare('INSERT INTO raw_row (batch_id, line_no, raw_text) VALUES (?, ?, ?) RETURNING id')
      .pluck(),
    copy: db.prepare(
      'INSERT INTO batch_row (batch_id, target, kind, dedup_key, payload_json) VALUES (?, ?, ?, ?, ?)',
    ),
    trade: db.prepare(INSERT_TRADE_SQL),
    statement: db.prepare(INSERT_STATEMENT_SQL),
  };
}

/** Inserts one canonical trade row (and its raw row and batch copy); true when it was new for the account. */
function insertTrade(
  sql: Pick<Statements, 'raw' | 'copy' | 'trade'>,
  accountId: string,
  batchId: string,
  row: CanonicalRow,
): boolean {
  const rawRowId: unknown = sql.raw.get(batchId, row.raw.line, row.raw.text);
  sql.copy.run(batchId, 'trade', '', row.dedupKey, encodeTradePayload(row));
  return sql.trade.run(tradeParams(accountId, batchId, rawRowId, row)).changes > 0;
}

function insertStatement(
  sql: Pick<Statements, 'copy' | 'statement'>,
  accountId: string,
  batchId: string,
  row: StatementRow,
): boolean {
  sql.copy.run(batchId, 'statement', row.kind, row.dedupKey, encodeStatementPayload(row));
  return (
    sql.statement.run(accountId, batchId, row.kind, row.dedupKey, JSON.stringify(row.key), toJson(row.data))
      .changes > 0
  );
}

/** Writes every file as its own batch. Call inside a transaction. */
export function writeBatches(
  db: Database.Database,
  accountId: string,
  files: readonly ParsedFile[],
  createdAt: string,
): CommittedBatch[] {
  const sql = prepare(db);
  return files.map((file) => {
    const batchId = randomUUID();
    sql.batch.run({
      id: batchId,
      accountId,
      sha256: file.sha256,
      kind: file.kind,
      adapterVersion: file.adapterVersion,
      from: file.result.coverage?.from ?? null,
      to: file.result.coverage?.to ?? null,
      counts: '{}',
      createdAt,
    });
    let rows = 0;
    for (const row of file.result.rows) if (insertTrade(sql, accountId, batchId, row)) rows += 1;
    let statements = 0;
    for (const row of file.result.statements)
      if (insertStatement(sql, accountId, batchId, row)) statements += 1;
    // What the commit actually did (the preview's counts can be stale by now).
    const counts: PreviewCounts = {
      rows: { new: rows, duplicate: file.result.rows.length - rows },
      statements: { new: statements, duplicate: file.result.statements.length - statements },
      skipped: file.counts.skipped,
      errors: file.counts.errors,
    };
    sql.counts.run(JSON.stringify(counts), batchId);
    return { batchId, kind: file.kind, inserted: { rows, statements } };
  });
}
