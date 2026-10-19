// Opens (and creates or upgrades) a vault: hardened connection, WAL, foreign keys, bigint integers, migrations.
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { autoBackup } from './backup.js';
import { VaultError } from './errors.js';
import { loadMigrations, migrate, type Migration } from './migrations.js';
import { APPLICATION_ID, hardenConnection } from './schema.js';

export interface OpenVaultOptions {
  readonly appVersion: string;
  /** Override the bundled migrations (tests). */
  readonly migrations?: readonly Migration[];
  readonly now?: () => Date;
}

export function openVault(vaultPath: string, options: OpenVaultOptions): Database.Database {
  const existed = existsSync(vaultPath);
  const db = new Database(vaultPath);
  try {
    hardenConnection(db);
    const applicationId = Number(db.pragma('application_id', { simple: true }));
    if (existed && applicationId !== 0 && applicationId !== APPLICATION_ID) {
      throw new VaultError('this file is not a BhavBook vault');
    }
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const backupOptions = options.now
      ? { appVersion: options.appVersion, now: options.now }
      : { appVersion: options.appVersion };
    migrate(db, options.migrations ?? loadMigrations(), {
      // Back up an existing vault before changing its schema; a brand-new vault has nothing to lose.
      beforeApply: (from) => {
        if (existed && from > 0) autoBackup(db, vaultPath, 'pre-migration', backupOptions);
      },
      ...(options.now ? { now: options.now } : {}),
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
