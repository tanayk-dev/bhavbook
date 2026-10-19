// Backups and restore (ADR-0020): consistent snapshots via VACUUM INTO, atomic writes, verified restore.
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { decodeBhav, encodeBhav, looksLikeSqlite, sha256 } from './container.js';
import { BackupError } from './errors.js';
import { currentVersion, latestVersion, loadMigrations, migrate, type Migration } from './migrations.js';

export type BackupReason = 'manual' | 'pre-import' | 'pre-migration' | 'pre-restore';
/** Routine auto-backups kept per vault; pre-migration backups are never rotated away. */
export const AUTO_BACKUP_KEEP = 10;
/** Refuse to read anything bigger as a backup (a vault this size is far beyond v1 use). */
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;

export interface BackupOptions {
  readonly appVersion: string;
  readonly now?: () => Date;
}

function tempPath(target: string, tag: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${tag}-${randomBytes(6).toString('hex')}.tmp`,
  );
}

/** Writes `bytes` to `target` atomically (temp file in the same directory, then rename). */
function writeAtomic(target: string, bytes: Buffer): void {
  const temp = tempPath(target, 'write');
  try {
    writeFileSync(temp, bytes, { flag: 'wx' });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Snapshots the open vault into a `.bhav` file. */
export function createBackup(
  db: Database.Database,
  outPath: string,
  appVersion: string,
  now: () => Date = () => new Date(),
): { path: string; sha256: string; bytes: number } {
  const snapshot = tempPath(outPath, 'snapshot');
  try {
    // VACUUM INTO gives a transactionally consistent copy; the path is bound, never interpolated.
    db.prepare('VACUUM INTO ?').run(snapshot);
    const bytes = readFileSync(snapshot);
    const file = encodeBhav(bytes, {
      schemaVersion: currentVersion(db),
      appVersion,
      createdAt: now().toISOString(),
    });
    writeAtomic(outPath, file);
    return { path: outPath, sha256: sha256(bytes), bytes: file.length };
  } finally {
    rmSync(snapshot, { force: true });
  }
}

export function backupDir(vaultPath: string): string {
  return `${vaultPath}.backups`;
}

function stamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** Writes `<vault>.backups/auto-<UTC>-<reason>.bhav` and rotates routine backups. */
export function autoBackup(
  db: Database.Database,
  vaultPath: string,
  reason: BackupReason,
  options: BackupOptions,
): string {
  const now = options.now ?? (() => new Date());
  const dir = backupDir(vaultPath);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `auto-${stamp(now())}-${reason}.bhav`);
  createBackup(db, target, options.appVersion, now);
  const routine = readdirSync(dir)
    .filter((name) => /^auto-.*\.bhav$/.test(name) && !name.endsWith('-pre-migration.bhav'))
    .sort();
  for (const name of routine.slice(0, Math.max(0, routine.length - AUTO_BACKUP_KEEP))) {
    rmSync(path.join(dir, name), { force: true });
  }
  return target;
}

function snapshotExisting(vaultPath: string, options: BackupOptions): void {
  if (!existsSync(vaultPath)) return;
  const live = new Database(vaultPath, { fileMustExist: true });
  try {
    autoBackup(live, vaultPath, 'pre-restore', options);
  } finally {
    live.close();
  }
}

export interface RestoreOptions extends BackupOptions {
  readonly migrations?: readonly Migration[];
}

/**
 * Restores a `.bhav` file over `vaultPath`. The live vault must be closed. Nothing touches it until the backup has
 * been verified (header, lengths, checksum, SQLite integrity) and migrated forward in a temp file next to it.
 */
export function restoreBackup(
  file: string,
  vaultPath: string,
  options: RestoreOptions,
): { schemaVersion: number } {
  const migrations = options.migrations ?? loadMigrations();
  if (statSync(file).size > MAX_BACKUP_BYTES) throw new BackupError('backup file is too large');
  const { manifest, db: bytes } = decodeBhav(readFileSync(file));
  if (manifest.schemaVersion > latestVersion(migrations)) {
    throw new BackupError('backup was made by a newer version of BhavBook; please upgrade');
  }
  if (!looksLikeSqlite(bytes)) throw new BackupError('backup does not contain a SQLite database');

  const staged = tempPath(vaultPath, 'restore');
  try {
    writeFileSync(staged, bytes, { flag: 'wx' });
    const db = new Database(staged, { fileMustExist: true });
    try {
      db.defaultSafeIntegers(true);
      const integrity = db.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new BackupError('backup database failed its integrity check');
      migrate(db, migrations, options.now ? { now: options.now } : {});
      db.pragma('journal_mode = DELETE');
    } finally {
      db.close();
    }
    snapshotExisting(vaultPath, options);
    for (const suffix of ['-wal', '-shm']) rmSync(`${vaultPath}${suffix}`, { force: true });
    renameSync(staged, vaultPath);
    return { schemaVersion: latestVersion(migrations) };
  } finally {
    rmSync(staged, { force: true });
  }
}
