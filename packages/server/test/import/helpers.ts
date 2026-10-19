// Shared helpers for import tests: a vault with one Zerodha and one Dhan account, fixture bytes, CSV windows.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { createImportService, type ImportFile, type ImportService, type ImportServiceOptions } from '../../src/import/index.js';
import { openVault } from '../../src/vault/index.js';

export const FIXTURES = fileURLToPath(new URL('../../../adapters/fixtures/', import.meta.url));
export const ZERODHA = 'acc_zerodha';
export const DHAN = 'acc_dhan';

export interface TestVault {
  readonly dir: string;
  readonly vaultPath: string;
  readonly db: Database.Database;
  readonly service: ImportService;
}

export function seedAccounts(db: Database.Database): void {
  const at = '2026-10-19T00:00:00Z';
  db.prepare("INSERT INTO pan_entity (id, label, created_at) VALUES ('pan1', 'Default', ?)").run(at);
  db.prepare("INSERT INTO profile (id, pan_entity_id, name, created_at) VALUES ('prof1', 'pan1', 'Swing', ?)").run(at);
  const account = db.prepare(
    "INSERT INTO broker_account (id, profile_id, broker, nickname, created_at) VALUES (?, 'prof1', ?, ?, ?)",
  );
  account.run(ZERODHA, 'zerodha', 'Z main', at);
  account.run(DHAN, 'dhan', 'D main', at);
}

/** Runs `run` against a fresh vault (seeded with two accounts) and cleans up afterwards. */
export async function withVault(
  run: (vault: TestVault) => Promise<void> | void,
  options: Partial<ImportServiceOptions> = {},
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bhavbook-import-'));
  const vaultPath = path.join(dir, 'vault.db');
  const db = openVault(vaultPath, { appVersion: 'test' });
  try {
    seedAccounts(db);
    const service = createImportService({ db, vaultPath, appVersion: 'test', ...options });
    await run({ dir, vaultPath, db, service });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function fixtureBytes(broker: string, kind: string): Buffer {
  const dir = path.join(FIXTURES, broker, kind);
  const [file] = readdirSync(dir);
  if (!file) throw new Error(`no fixture in ${dir}`);
  return readFileSync(path.join(dir, file));
}

export function fixtureFile(broker: string, kind: string, name = `${kind}.csv`): ImportFile {
  return { bytes: fixtureBytes(broker, kind), name };
}

/** Header plus data lines `[from, to)` of a CSV fixture, as a new file. */
export function csvWindow(broker: string, kind: string, from: number, to: number): ImportFile {
  const [header = '', ...rows] = fixtureBytes(broker, kind).toString('utf8').split(/\r?\n/).filter(Boolean);
  return { bytes: Buffer.from([header, ...rows.slice(from, to)].join('\r\n') + '\r\n', 'utf8'), name: 'window.csv' };
}

/** Dhan trade history split at a whole day: rows on or before `lastDay`, and rows on or after `firstDay`. */
export function dhanDays(filter: (date: string) => boolean): ImportFile {
  const [header = '', ...rows] = fixtureBytes('dhan', 'trade_history').toString('utf8').split(/\r?\n/).filter(Boolean);
  const kept = rows.filter((row) => filter(row.slice(0, 10)));
  return { bytes: Buffer.from([header, ...kept].join('\r\n'), 'utf8'), name: 'days.csv' };
}

export function count(db: Database.Database, table: string, where = '1 = 1'): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get() as { n: bigint };
  return Number(row.n);
}

/** Every trade row of an account, without ids or owning batch: what the account "contains". */
export function tradeSet(db: Database.Database, accountId: string): string[] {
  return (
    db
      .prepare(
        `SELECT dedup_key, granularity, source, external_order_id, executed_at_utc, trade_date_ist, side, quantity,
                price_micro, trade_value_micro, value_authority, exchange, isin, broker_symbol, broker_name,
                product_declared, flags_json
         FROM trade_row WHERE account_id = ? ORDER BY dedup_key`,
      )
      .all(accountId) as Record<string, unknown>[]
  ).map((row) => JSON.stringify(row, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)));
}

/** Preview then commit, failing the test if any file isn't importable. */
export async function importFiles(service: ImportService, accountId: string, files: ImportFile[]): Promise<void> {
  const preview = await service.previewImport(accountId, files);
  const notReady = preview.files.filter((file) => file.status !== 'ready');
  if (notReady.length > 0 || preview.token === null) throw new Error(`not importable: ${JSON.stringify(notReady)}`);
  service.commitImport(preview.token);
}
