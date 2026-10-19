// Commit (PRD §5.1): one transaction per commit. Every batch keeps its raw rows (ADR-0007) and its own canonical
// copy of each row (`batch_row`, schema 0002); trade_row/statement_row keep the first batch's row per dedup key
// (ADR-0009), so re-imports insert nothing.
import { randomUUID } from 'node:crypto';
import type { CanonicalRow, StatementRow } from '@bhavbook/adapters';
import type Database from 'better-sqlite3';
import { toJson } from '../http/json.js';
import type { ParsedFile } from './preview.js';

export interface CommittedBatch {
  readonly batchId: string;
  readonly kind: string;
  readonly inserted: { readonly rows: number; readonly statements: number };
}

interface Statements {
  readonly batch: Database.Statement;
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
    raw: db
      .prepare('INSERT INTO raw_row (batch_id, line_no, raw_text) VALUES (?, ?, ?) RETURNING id')
      .pluck(),
    copy: db.prepare(
      'INSERT INTO batch_row (batch_id, target, kind, dedup_key, payload_json) VALUES (?, ?, ?, ?, ?)',
    ),
    trade: db.prepare(
      `INSERT INTO trade_row (account_id, batch_id, raw_row_id, dedup_key, granularity, source, external_order_id,
         executed_at_utc, trade_date_ist, side, quantity, price_micro, trade_value_micro, value_authority, exchange,
         isin, broker_symbol, broker_name, product_declared, flags_json)
       VALUES (@accountId, @batchId, @rawRowId, @dedupKey, @granularity, @source, @externalOrderId, @executedAtUtc,
         @tradeDateIst, @side, @quantity, @priceMicro, @tradeValueMicro, @valueAuthority, @exchange, @isin,
         @brokerSymbol, @brokerName, @productDeclared, @flags)
       ON CONFLICT (account_id, dedup_key) DO NOTHING`,
    ),
    statement: db.prepare(
      `INSERT INTO statement_row (account_id, batch_id, kind, dedup_key, key_json, data_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, kind, dedup_key) DO NOTHING`,
    ),
  };
}

/** Inserts one canonical trade row (and its raw row and batch copy); true when it was new for the account. */
export function insertTrade(
  sql: Pick<Statements, 'raw' | 'copy' | 'trade'>,
  accountId: string,
  batchId: string,
  row: CanonicalRow,
): boolean {
  const rawRowId = sql.raw.get(batchId, row.raw.line, row.raw.text) as bigint;
  sql.copy.run(batchId, 'trade', '', row.dedupKey, toJson(row));
  const params = {
    accountId,
    batchId,
    rawRowId,
    dedupKey: row.dedupKey,
    granularity: row.granularity,
    source: row.source,
    externalOrderId: row.externalOrderId,
    executedAtUtc: row.executedAtUtc,
    tradeDateIst: row.tradeDateIst,
    side: row.side,
    quantity: row.quantity,
    priceMicro: row.priceMicro,
    tradeValueMicro: row.tradeValueMicro,
    valueAuthority: row.valueAuthority,
    exchange: row.exchange,
    isin: row.isin,
    brokerSymbol: row.brokerSymbol,
    brokerName: row.brokerName,
    productDeclared: row.productDeclared,
    flags: JSON.stringify(row.flags),
  };
  return sql.trade.run(params).changes > 0;
}

export function insertStatement(
  sql: Pick<Statements, 'copy' | 'statement'>,
  accountId: string,
  batchId: string,
  row: StatementRow,
): boolean {
  sql.copy.run(batchId, 'statement', row.kind, row.dedupKey, toJson(row));
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
      counts: JSON.stringify(file.counts),
      createdAt,
    });
    let rows = 0;
    for (const row of file.result.rows) if (insertTrade(sql, accountId, batchId, row)) rows += 1;
    let statements = 0;
    for (const row of file.result.statements)
      if (insertStatement(sql, accountId, batchId, row)) statements += 1;
    return { batchId, kind: file.kind, inserted: { rows, statements } };
  });
}
