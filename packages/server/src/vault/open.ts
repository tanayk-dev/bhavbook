// Opens (and creates or upgrades) a vault: hardened connection, WAL, foreign keys, bigint integers, migrations.
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { autoBackup } from './backup.js';
import { VaultError } from './errors.js';
import { currentVersion, latestVersion, loadMigrations, migrate, type Migration } from './migrations.js';
import { APPLICATION_ID, createOwnerOnly, hardenConnection, restrictToOwner } from './schema.js';

export interface OpenVaultOptions {
  readonly appVersion: string;
  /** Override the bundled migrations (tests). */
  readonly migrations?: readonly Migration[];
  readonly now?: () => Date;
}

export function openVault(vaultPath: string, options: OpenVaultOptions): Database.Database {
  const existed = existsSync(vaultPath);
  if (!existed) createOwnerOnly(vaultPath);
  const db = new Database(vaultPath);
  try {
    restrictToOwner(vaultPath);
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

/**
 * Opens an existing, current vault read-only: no WAL switch, no migrations, no auto-backup. Safe beside a running
 * server (e.g. `bhavbook backup`). Refuses anything that is not a BhavBook vault at the bundled schema version.
 */
export function openVaultReadOnly(
  vaultPath: string,
  migrations: readonly Migration[] = loadMigrations(),
): Database.Database {
  let db: Database.Database;
  try {
    db = new Database(vaultPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new VaultError('there is no readable vault at that path', { cause: error });
  }
  try {
    hardenConnection(db);
    let version: number;
    try {
      if (Number(db.pragma('application_id', { simple: true })) !== APPLICATION_ID)
        throw new Error('application_id');
      version = currentVersion(db);
    } catch (error) {
      throw new VaultError('this file is not a BhavBook vault', { cause: error });
    }
    if (version < latestVersion(migrations)) {
      throw new VaultError('the vault needs an upgrade: start BhavBook once, then try again');
    }
    if (version > latestVersion(migrations)) {
      throw new VaultError('the vault was created by a newer version of BhavBook; please upgrade');
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
