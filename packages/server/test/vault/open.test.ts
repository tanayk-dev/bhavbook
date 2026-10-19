import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentVersion, latestVersion, loadMigrations, openVault } from '../../src/vault/index.js';
import { withTempDir } from './helpers.js';

const APP = '0.0.0-test';

describe('openVault', () => {
  it('creates a migrated vault with WAL, foreign keys and bigint integers', () => {
    withTempDir((dir) => {
      const db = openVault(path.join(dir, 'vault.db'), { appVersion: APP });
      expect(currentVersion(db)).toBe(latestVersion());
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1n);
      expect(typeof (db.prepare('SELECT 1 AS one').get() as { one: unknown }).one).toBe('bigint');
      db.close();
    });
  });

  it('backs up an existing vault before applying new migrations, but not a fresh one', () => {
    withTempDir((dir) => {
      const vaultPath = path.join(dir, 'vault.db');
      const [first] = loadMigrations();
      if (!first) throw new Error('no migrations');
      openVault(vaultPath, { appVersion: APP, migrations: [first] }).close();
      expect(() => readdirSync(`${vaultPath}.backups`)).toThrow();

      const next = { version: first.version + 1, name: 'extra', sql: 'CREATE TABLE extra (x INTEGER) STRICT;' };
      const db = openVault(vaultPath, { appVersion: APP, migrations: [first, next] });
      expect(currentVersion(db)).toBe(next.version);
      db.close();
      expect(readdirSync(`${vaultPath}.backups`).some((name) => name.includes('pre-migration'))).toBe(true);
    });
  });
});
