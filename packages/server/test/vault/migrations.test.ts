import { writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { currentVersion, loadMigrations, migrate, VaultError } from '../../src/vault/index.js';
import { withTempDir } from './helpers.js';

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.defaultSafeIntegers(true);
  return db;
}

describe('loadMigrations', () => {
  it('loads the bundled migrations in order, starting at 0001_init', () => {
    const migrations = loadMigrations();
    expect(migrations[0]).toMatchObject({ version: 1, name: 'init' });
    expect(migrations.map((migration) => migration.version)).toEqual(migrations.map((_, index) => index + 1));
  });

  it('rejects a gap in version numbers', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (x INTEGER) STRICT;');
      writeFileSync(path.join(dir, '0003_c.sql'), 'CREATE TABLE c (x INTEGER) STRICT;');
      expect(() => loadMigrations(dir)).toThrow(VaultError);
    });
  });

  it('rejects files that do not follow NNNN_name.sql', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, '1_init.sql'), 'SELECT 1;');
      expect(() => loadMigrations(dir)).toThrow(/NNNN_name\.sql/);
    });
  });
});

describe('migrate', () => {
  const migrations = [
    { version: 1, name: 'a', sql: 'CREATE TABLE a (x INTEGER NOT NULL) STRICT;' },
    { version: 2, name: 'b', sql: 'CREATE TABLE b (y TEXT NOT NULL) STRICT;' },
  ];

  it('applies pending migrations in order and records them', () => {
    const db = memoryDb();
    expect(currentVersion(db)).toBe(0);
    expect(migrate(db, migrations)).toEqual({ from: 0, to: 2 });
    expect(currentVersion(db)).toBe(2);
    const applied = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    expect(applied).toEqual([
      { version: 1n, name: 'a' },
      { version: 2n, name: 'b' },
    ]);
  });

  it('is a no-op when the vault is current', () => {
    const db = memoryDb();
    migrate(db, migrations);
    expect(migrate(db, migrations)).toEqual({ from: 2, to: 2 });
  });

  it('calls beforeApply only when something is pending', () => {
    const db = memoryDb();
    const calls: string[] = [];
    migrate(db, migrations.slice(0, 1));
    migrate(db, migrations, { beforeApply: (from, to) => calls.push(`${from}->${to}`) });
    migrate(db, migrations, { beforeApply: (from, to) => calls.push(`${from}->${to}`) });
    expect(calls).toEqual(['1->2']);
  });

  it('rolls back a failing migration completely', () => {
    const db = memoryDb();
    const broken = [...migrations, { version: 3, name: 'broken', sql: 'CREATE TABLE c (z INTEGER) STRICT; NOT SQL;' }];
    expect(() => migrate(db, broken)).toThrow();
    expect(currentVersion(db)).toBe(2);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'c'").all();
    expect(tables).toEqual([]);
  });

  it('refuses a vault written by a newer BhavBook', () => {
    const db = memoryDb();
    migrate(db, migrations);
    expect(() => migrate(db, migrations.slice(0, 1))).toThrow(/newer/);
  });
});
