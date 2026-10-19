// Shared helpers for vault tests: temp directories and a migrated in-memory database.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadMigrations, migrate } from '../../src/vault/index.js';

/** Runs `run` in a fresh temp directory and removes it afterwards (after the promise settles, for async tests). */
export function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'bhavbook-vault-'));
  const cleanup = (): void => {
    rmSync(dir, { recursive: true, force: true });
  };
  let result: T;
  try {
    result = run(dir);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result instanceof Promise) return result.finally(cleanup) as T;
  cleanup();
  return result;
}

export function migratedMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.defaultSafeIntegers(true);
  db.pragma('foreign_keys = ON');
  migrate(db, loadMigrations());
  return db;
}

/** Inserts a profile → account → import batch chain and returns their ids. */
export function seedAccount(db: Database.Database): { accountId: string; batchId: string } {
  db.prepare(
    "INSERT INTO pan_entity (id, label, created_at) VALUES ('pan1', 'Default', '2026-10-19T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO profile (id, pan_entity_id, name, created_at) VALUES ('prof1', 'pan1', 'Swing', '2026-10-19T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO broker_account (id, profile_id, broker, nickname, created_at) VALUES ('acc1', 'prof1', 'dhan', 'Main', '2026-10-19T00:00:00Z')",
  ).run();
  db.prepare(
    `INSERT INTO import_batch (id, account_id, file_sha256, report_kind, adapter_version, counts_json, status, created_at)
     VALUES ('batch1', 'acc1', ?, 'dhan.trade_history', '1', '{}', 'committed', '2026-10-19T00:00:00Z')`,
  ).run('a'.repeat(64));
  return { accountId: 'acc1', batchId: 'batch1' };
}

export function insertTrade(db: Database.Database, overrides: Partial<Record<string, unknown>> = {}): void {
  const row = {
    account_id: 'acc1',
    batch_id: 'batch1',
    dedup_key: 'k1',
    granularity: 'order',
    source: 'tradebook',
    executed_at_utc: '2024-09-18T03:46:45Z',
    trade_date_ist: '2024-09-18',
    side: 'SELL',
    quantity: 200n,
    price_micro: 174_050_000n,
    trade_value_micro: 34_810_000_000n,
    value_authority: 'value',
    exchange: 'NSE',
    flags_json: '{}',
    ...overrides,
  };
  db.prepare(
    `INSERT INTO trade_row (account_id, batch_id, dedup_key, granularity, source, executed_at_utc, trade_date_ist, side,
       quantity, price_micro, trade_value_micro, value_authority, exchange, flags_json)
     VALUES (@account_id, @batch_id, @dedup_key, @granularity, @source, @executed_at_utc, @trade_date_ist, @side,
       @quantity, @price_micro, @trade_value_micro, @value_authority, @exchange, @flags_json)`,
  ).run(row);
}
