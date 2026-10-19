// Review follow-ups for S4: hostile backups, safe swaps, schema integrity, migration safety.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_ID,
  autoBackup,
  BackupError,
  currentVersion,
  encodeBhav,
  loadMigrations,
  migrate,
  openVault,
  restoreBackup,
  VaultError,
} from '../../src/vault/index.js';
import { insertTrade, migratedMemoryDb, seedAccount, withTempDir } from './helpers.js';

const APP = '0.0.0-test';

/** A schema-1 vault, optionally tampered with, packed as a .bhav file. */
function backupWith(dir: string, tamper: (db: Database.Database) => void): string {
  const vaultPath = path.join(dir, 'source.db');
  const db = openVault(vaultPath, { appVersion: APP });
  seedAccount(db);
  insertTrade(db);
  tamper(db);
  const raw = path.join(dir, 'raw.db');
  db.prepare('VACUUM INTO ?').run(raw);
  db.close();
  const file = path.join(dir, 'tampered.bhav');
  writeFileSync(file, encodeBhav(readFileSync(raw), { schemaVersion: 1, appVersion: APP, createdAt: 'x' }));
  return file;
}

describe('restore rejects hostile or foreign databases', () => {
  it.each([
    ['a trigger', 'CREATE TRIGGER evil AFTER INSERT ON import_batch BEGIN DELETE FROM trade_row; END;'],
    ['a view', 'CREATE VIEW sneaky AS SELECT * FROM trade_row;'],
    ['an extra table', 'CREATE TABLE extra (x INTEGER) STRICT;'],
    ['an altered table', 'ALTER TABLE setting ADD COLUMN hidden TEXT;'],
  ])('refuses %s that the migrations did not create', (_label, sql) => {
    withTempDir((dir) => {
      const file = backupWith(dir, (db) => db.exec(sql));
      const target = path.join(dir, 'vault.db');
      expect(() => restoreBackup(file, target, { appVersion: APP })).toThrow(/schema/);
      expect(existsSync(target)).toBe(false);
    });
  });

  it('refuses a SQLite file that is not a BhavBook vault (application id)', () => {
    withTempDir((dir) => {
      const file = backupWith(dir, (db) => db.pragma('application_id = 7'));
      expect(() => restoreBackup(file, path.join(dir, 'vault.db'), { appVersion: APP })).toThrow(/not a BhavBook/);
    });
  });

  it('refuses a backup whose manifest version disagrees with its migration history', () => {
    withTempDir((dir) => {
      const file = backupWith(dir, (db) => db.prepare('DELETE FROM schema_migrations').run());
      expect(() => restoreBackup(file, path.join(dir, 'vault.db'), { appVersion: APP })).toThrow(/migration history/);
    });
  });

  it('wraps SQLite and file-system errors in fixed messages (no paths or row data)', () => {
    withTempDir((dir) => {
      const missing = path.join(dir, 'secret-name-123.bhav');
      try {
        restoreBackup(missing, path.join(dir, 'vault.db'), { appVersion: APP });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(BackupError);
        expect((error as Error).message).not.toContain('secret-name-123');
      }
    });
  });
});

describe('restore swaps safely', () => {
  it('refuses while the live vault is open elsewhere', () => {
    withTempDir((dir) => {
      const vaultPath = path.join(dir, 'vault.db');
      const live = openVault(vaultPath, { appVersion: APP });
      const file = backupWith(dir, () => undefined);
      try {
        expect(() => restoreBackup(file, vaultPath, { appVersion: APP })).toThrow(/in use/);
      } finally {
        live.close();
      }
    });
  });

  it('restores over a corrupt live vault, keeping a raw copy of it', () => {
    withTempDir((dir) => {
      const vaultPath = path.join(dir, 'vault.db');
      writeFileSync(vaultPath, 'this is not a database');
      const file = backupWith(dir, () => undefined);
      restoreBackup(file, vaultPath, { appVersion: APP });
      const db = openVault(vaultPath, { appVersion: APP });
      expect(db.prepare('SELECT count(*) AS n FROM trade_row').get()).toEqual({ n: 1n });
      db.close();
      expect(readdirSync(`${vaultPath}.backups`).some((name) => name.includes('pre-restore-raw'))).toBe(true);
    });
  });

  it('leaves the live vault untouched when migrating the backup fails', () => {
    withTempDir((dir) => {
      const vaultPath = path.join(dir, 'vault.db');
      openVault(vaultPath, { appVersion: APP }).close();
      const before = readFileSync(vaultPath);
      const file = backupWith(dir, () => undefined);
      const [first] = loadMigrations();
      if (!first) throw new Error('no migrations');
      const broken = { version: 2, name: 'broken', sql: 'NOT SQL;' };
      expect(() => restoreBackup(file, vaultPath, { appVersion: APP, migrations: [first, broken] })).toThrow();
      expect(readFileSync(vaultPath).equals(before)).toBe(true);
      expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([]);
    });
  });
});

describe('auto-backup names', () => {
  it('never collide, even within the same millisecond', () => {
    withTempDir((dir) => {
      const vaultPath = path.join(dir, 'vault.db');
      const db = openVault(vaultPath, { appVersion: APP });
      const now = (): Date => new Date('2026-10-19T00:00:00.000Z');
      for (let i = 0; i < 3; i += 1) autoBackup(db, vaultPath, 'pre-import', { appVersion: APP, now });
      db.close();
      expect(readdirSync(`${vaultPath}.backups`)).toHaveLength(3);
    });
  });
});

describe('schema integrity', () => {
  it('marks the file as a BhavBook vault', () => {
    expect(migratedMemoryDb().pragma('application_id', { simple: true })).toBe(BigInt(APPLICATION_ID));
  });

  it('requires exactly one source per allocation (trade, adjustment or corporate action)', () => {
    const db = migratedMemoryDb();
    seedAccount(db);
    const insert = db.prepare(
      `INSERT INTO fill_allocation (account_id, trade_row_id, adjustment_id, corporate_action_id, instrument_key, bucket,
         side, quantity, value_micro, inferred) VALUES ('acc1', ?, ?, ?, 'INE000000000', 'DELIVERY', 'BUY', 1, 0, 0)`,
    );
    expect(() => insert.run(null, null, null)).toThrow(/CHECK/);
    db.prepare(
      `INSERT INTO corporate_action (id, type, isin, ex_date, allotment_date, ratio_num, ratio_den, status, created_at)
       VALUES ('ca1', 'BONUS', 'INE000000000', '2025-01-01', '2025-01-03', 1, 1, 'active', 'now')`,
    ).run();
    expect(() => insert.run(null, null, 'ca1')).not.toThrow();
  });

  it('requires a new ISIN and a cost split for a demerger', () => {
    const db = migratedMemoryDb();
    const insert = db.prepare(
      `INSERT INTO corporate_action (id, type, isin, new_isin, ex_date, ratio_num, ratio_den, cost_split_bp, status, created_at)
       VALUES (?, 'DEMERGER', 'INE155A01022', ?, '2025-10-14', 1, 1, ?, 'active', 'now')`,
    );
    expect(() => insert.run('d1', null, 3115)).toThrow(/CHECK/);
    expect(() => insert.run('d2', 'INE1TAE01010', null)).toThrow(/CHECK/);
    expect(() => insert.run('d3', 'INE1TAE01010', 3115)).not.toThrow();
  });

  it('never deletes journal entries or adjustments with an account (they are user data)', () => {
    const db = migratedMemoryDb();
    seedAccount(db);
    db.prepare(
      `INSERT INTO journal_entry (id, anchor_account_id, anchor_instrument_key, anchor_bucket, anchor_key, status, created_at, updated_at)
       VALUES ('j1', 'acc1', 'INE000000000', 'DELIVERY', 'k1', 'attached', 'now', 'now')`,
    ).run();
    expect(() => db.prepare("DELETE FROM broker_account WHERE id = 'acc1'").run()).toThrow(/FOREIGN KEY/);
  });

  it('keeps exit fields of a lot all set or all empty', () => {
    const db = migratedMemoryDb();
    seedAccount(db);
    insertTrade(db);
    db.prepare(
      `INSERT INTO fill_allocation (id, account_id, trade_row_id, instrument_key, bucket, side, quantity, value_micro, inferred)
       VALUES (1, 'acc1', 1, 'INE000000000', 'DELIVERY', 'BUY', 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO position (id, account_id, instrument_key, bucket, state, incomplete, opened_at_utc, anchor_key)
       VALUES ('p1', 'acc1', 'INE000000000', 'DELIVERY', 'OPEN', 0, 'now', 'k1')`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO lot (position_id, entry_allocation_id, exit_allocation_id, quantity, entry_value_micro, exit_value_micro, entry_date_ist, exit_date_ist)
       VALUES ('p1', 1, ?, 1, 0, ?, '2025-01-01', ?)`,
    );
    expect(() => insert.run(null, 5n, null)).toThrow(/CHECK/);
    expect(() => insert.run(null, null, null)).not.toThrow();
  });

  it('keeps one issue per (account, kind, fingerprint), also for vault-wide issues', () => {
    const db = migratedMemoryDb();
    const insert = db.prepare(
      "INSERT INTO issue (id, account_id, kind, fingerprint, subject_json, status, created_at) VALUES (?, NULL, 'x', 'f', '{}', 'open', 'now')",
    );
    insert.run('i1');
    expect(() => insert.run('i2')).toThrow(/UNIQUE/);
  });
});

describe('migration safety', () => {
  it('rebuilds a table without cascading deletes into its children', () => {
    const db = new Database(':memory:');
    db.defaultSafeIntegers(true);
    db.pragma('foreign_keys = ON');
    const base = [
      {
        version: 1,
        name: 'base',
        sql: `CREATE TABLE parent (id TEXT PRIMARY KEY) STRICT;
              CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent (id) ON DELETE CASCADE) STRICT;
              INSERT INTO parent VALUES ('p'); INSERT INTO child VALUES ('c', 'p');`,
      },
    ];
    migrate(db, base);
    const rebuild = {
      version: 2,
      name: 'rebuild_parent',
      sql: `CREATE TABLE parent_new (id TEXT PRIMARY KEY, label TEXT) STRICT;
            INSERT INTO parent_new (id) SELECT id FROM parent;
            DROP TABLE parent;
            ALTER TABLE parent_new RENAME TO parent;`,
    };
    migrate(db, [...base, rebuild]);
    expect(db.prepare('SELECT count(*) AS n FROM child').get()).toEqual({ n: 1n });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1n);
  });

  it('refuses a migration whose released SQL was edited', () => {
    const db = new Database(':memory:');
    migrate(db, [{ version: 1, name: 'a', sql: 'CREATE TABLE a (x INTEGER) STRICT;' }]);
    expect(() => migrate(db, [{ version: 1, name: 'a', sql: 'CREATE TABLE a (y INTEGER) STRICT;' }])).toThrow(
      VaultError,
    );
  });

  it('reads the version of an empty database without writing to it', () => {
    const db = new Database(':memory:');
    expect(currentVersion(db)).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'schema_migrations'").get()).toEqual({
      n: 0,
    });
  });
});
