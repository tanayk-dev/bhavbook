// Backups and restore (ADR-0020): consistent snapshots via VACUUM INTO, atomic owner-only writes, and a restore that
// treats the backup as hostile until it is proven to be a BhavBook vault with exactly the expected schema.
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { decodeBhav, encodeBhav, looksLikeSqlite, sha256 } from './container.js';
import { BackupError, VaultError } from './errors.js';
import {
  appliedMigrations,
  assertHistoryMatches,
  currentVersion,
  latestVersion,
  loadMigrations,
  migrate,
  type Migration,
} from './migrations.js';
import { APPLICATION_ID, hardenConnection, referenceFingerprint, schemaFingerprint } from './schema.js';

export type BackupReason = 'manual' | 'pre-import' | 'pre-undo' | 'pre-migration' | 'pre-restore';
/** Routine auto-backups kept per vault; pre-migration backups are never rotated away. */
export const AUTO_BACKUP_KEEP = 10;
/** Largest backup we will read (far beyond v1 use; bounded so a hostile file can't exhaust memory). */
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const SQLITE_MIN_PAGE = 512;
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;

export interface BackupOptions {
  readonly appVersion: string;
  readonly now?: () => Date;
}

function nowOf(options: BackupOptions): Date {
  return options.now?.() ?? new Date();
}

function tempPath(target: string, tag: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${tag}-${randomBytes(6).toString('hex')}.tmp`,
  );
}

/** Writes `bytes` to `target` atomically and owner-only (temp file in the same directory, then rename). */
function writeAtomic(target: string, bytes: Buffer): void {
  const temp = tempPath(target, 'write');
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: OWNER_ONLY_FILE });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** A path in canonical form for comparison: resolved, symlinks followed when it exists, case-folded where the
 * file system usually is case-insensitive (erring towards "same" only ever refuses a backup). */
function canonical(file: string): string {
  let resolved = path.resolve(file);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    // Not there yet: compare the resolved path.
  }
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

const VAULT_FILE_SUFFIXES = ['', '-wal', '-shm', '-journal', '.lock'] as const;

/** Whether `file` is the vault at `vaultPath` or one of its sidecar / lock files. */
export function isVaultFile(file: string, vaultPath: string): boolean {
  if (vaultPath === '' || vaultPath === ':memory:') return false;
  const target = canonical(file);
  return VAULT_FILE_SUFFIXES.some((suffix) => target === canonical(`${vaultPath}${suffix}`));
}

/** Snapshots the open vault into a `.bhav` file. */
export function createBackup(
  db: Database.Database,
  outPath: string,
  options: BackupOptions,
): { path: string; sha256: string; bytes: number } {
  if (isVaultFile(outPath, db.name))
    throw new BackupError('refusing to write a backup over the vault or its files');
  const snapshot = tempPath(outPath, 'snapshot');
  try {
    // VACUUM INTO gives a transactionally consistent copy; the path is bound, never interpolated.
    db.prepare('VACUUM INTO ?').run(snapshot);
    const bytes = readFileSync(snapshot);
    const file = encodeBhav(bytes, {
      schemaVersion: currentVersion(db),
      appVersion: options.appVersion,
      createdAt: nowOf(options).toISOString(),
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
  return date.toISOString().replace(/[-:.]/g, '');
}

/** A file name in the backup directory that doesn't exist yet: `<prefix>-<UTC ms>-<reason>[-n].<ext>`. */
function uniqueBackupPath(
  dir: string,
  prefix: string,
  date: Date,
  reason: string,
  extension: string,
): string {
  const base = `${prefix}-${stamp(date)}-${reason}`;
  // Above the highest counter in use for this stamp, never a freed one (the bare name counts as 1): rotation
  // orders same-millisecond backups by counter, so a reused name would look older than it is.
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}(?:-(\\d+))?\\.${extension}$`);
  const highest = readdirSync(dir).reduce((max, name) => {
    const match = pattern.exec(name);
    const counter = match === null ? 0 : Number.parseInt(match[1] ?? '1', 10);
    return counter > max ? counter : max;
  }, 0);
  if (highest === 0) return path.join(dir, `${base}.${extension}`);
  return path.join(dir, `${base}-${String(highest + 1)}.${extension}`);
}

function ensureBackupDir(vaultPath: string): string {
  const dir = backupDir(vaultPath);
  mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });
  return dir;
}

/** `auto-<stamp>-<reason>[-<n>].bhav`: stamp, reason, collision counter. Other names are never rotated. */
const AUTO_NAME = /^auto-(\d{8}T\d{9}Z)-([a-z]+(?:-[a-z]+)*?)(?:-(\d+))?\.bhav$/;

/** Writes `<vault>.backups/auto-<UTC>-<reason>.bhav` and rotates routine backups. */
export function autoBackup(
  db: Database.Database,
  vaultPath: string,
  reason: BackupReason,
  options: BackupOptions,
): string {
  const dir = ensureBackupDir(vaultPath);
  const target = uniqueBackupPath(dir, 'auto', nowOf(options), reason, 'bhav');
  createBackup(db, target, options);
  // Rotation is per reason, so frequent imports can't push out other restore points; pre-migration backups are
  // kept forever (they are the only way back from a schema change).
  const byReason = new Map<string, { name: string; stamp: string; counter: number }[]>();
  for (const name of readdirSync(dir)) {
    const match = AUTO_NAME.exec(name);
    const [, stamp = '', reason = '', counter = '1'] = match ?? [];
    if (match === null || reason === 'pre-migration') continue;
    const entry = { name, stamp, counter: Number.parseInt(counter, 10) };
    byReason.set(reason, [...(byReason.get(reason) ?? []), entry]);
  }
  for (const entries of byReason.values()) {
    // Oldest first: by time stamp, then by collision counter within the same millisecond.
    const ordered = [...entries].sort((a, b) =>
      a.stamp === b.stamp ? a.counter - b.counter : a.stamp < b.stamp ? -1 : 1,
    );
    for (const { name } of ordered.slice(0, Math.max(0, ordered.length - AUTO_BACKUP_KEEP))) {
      rmSync(path.join(dir, name), { force: true });
    }
  }
  return target;
}

/** Reads a whole file through one descriptor, so the size check and the read can't disagree (no TOCTOU). */
function readBounded(file: string): Buffer {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_BACKUP_BYTES) throw new BackupError('backup file is too large');
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, buffer, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== size) throw new BackupError('backup file changed while it was being read');
    return buffer;
  } finally {
    closeSync(fd);
  }
}

/** Proves the staged database is a BhavBook vault whose schema and history are exactly what we would create. */
function verifyStaged(staged: string, manifestVersion: number, migrations: readonly Migration[]): void {
  const db = new Database(staged, { readonly: true, fileMustExist: true });
  try {
    hardenConnection(db);
    if (Number(db.pragma('application_id', { simple: true })) !== APPLICATION_ID) {
      throw new BackupError('backup is not a BhavBook vault');
    }
    if (db.pragma('integrity_check', { simple: true }) !== 'ok')
      throw new BackupError('backup failed its integrity check');
    if ((db.pragma('foreign_key_check') as unknown[]).length > 0)
      throw new BackupError('backup has broken references');
    const history = appliedMigrations(db);
    try {
      assertHistoryMatches(history, migrations);
    } catch (error) {
      throw new BackupError('backup migration history does not match this version of BhavBook', {
        cause: error,
      });
    }
    if ((history.at(-1)?.version ?? 0) !== manifestVersion) {
      throw new BackupError('backup manifest and migration history disagree');
    }
    const expected = referenceFingerprint(migrations, manifestVersion).join('\n');
    if (schemaFingerprint(db).join('\n') !== expected) {
      throw new BackupError('backup database has an unexpected schema (extra or altered objects)');
    }
  } finally {
    db.close();
  }
}

/**
 * Builds a fresh vault from our own migrations at the backup's version and copies the backup's rows into it, table
 * by table. Nothing from the backup's schema survives, and every STRICT type, NOT NULL, CHECK and foreign key is
 * enforced again on insert (integrity_check alone does not catch rows that break CHECK constraints). Then migrates
 * the result forward to the latest version.
 */
function rebuildFromBackup(
  staged: string,
  target: string,
  version: number,
  migrations: readonly Migration[],
  options: BackupOptions,
): void {
  const db = new Database(target);
  try {
    hardenConnection(db);
    const now = options.now ? { now: options.now } : {};
    migrate(
      db,
      migrations.filter((migration) => migration.version <= version),
      now,
    );
    db.pragma('foreign_keys = OFF');
    db.prepare('ATTACH DATABASE ? AS backup').run(staged);
    const tables = (
      db
        .prepare(
          "SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name NOT IN ('schema_migrations', 'sqlite_stat1', 'sqlite_stat4')",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    db.transaction(() => {
      for (const table of tables) {
        const columns = (
          db.prepare('SELECT name FROM main.pragma_table_info(?)').all(table) as { name: string }[]
        )
          .map((column) => `"${column.name.replace(/"/g, '""')}"`)
          .join(', ');
        const quoted = `"${table.replace(/"/g, '""')}"`;
        db.exec(`INSERT INTO main.${quoted} (${columns}) SELECT ${columns} FROM backup.${quoted}`);
      }
    })();
    db.exec('DETACH DATABASE backup');
    if ((db.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new BackupError('backup has broken references');
    }
    db.pragma('foreign_keys = ON');
    migrate(db, migrations, now);
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
}

function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    String((error as { code: unknown }).code).startsWith('SQLITE_BUSY')
  );
}

function sqliteCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : '';
}

function isCorrupt(error: unknown): boolean {
  const code = sqliteCode(error);
  return code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB';
}

/** Copies an unreadable live vault (and its WAL) into the backup directory, verifying the copy's size. */
function keepRawCopy(vaultPath: string, options: BackupOptions): void {
  const dir = ensureBackupDir(vaultPath);
  const raw = uniqueBackupPath(dir, 'raw', nowOf(options), 'pre-restore-raw', 'db');
  for (const suffix of ['', '-wal']) {
    if (!existsSync(`${vaultPath}${suffix}`)) continue;
    copyFileSync(`${vaultPath}${suffix}`, `${raw}${suffix}`);
    if (statSync(`${raw}${suffix}`).size !== statSync(`${vaultPath}${suffix}`).size) {
      throw new BackupError('could not copy the current vault before restoring; nothing was changed');
    }
  }
}

/**
 * Takes an exclusive lock on the live vault (fails if any other connection has it open), snapshots it, and
 * checkpoints its WAL so the file on disk is complete. A live vault that can't be read is copied raw instead.
 */
function retireLiveVault(vaultPath: string, options: BackupOptions): void {
  if (!existsSync(vaultPath)) return;
  let live: Database.Database | undefined;
  try {
    // timeout 0: report "in use" at once instead of waiting for the other connection.
    live = new Database(vaultPath, { fileMustExist: true, timeout: 0 });
    hardenConnection(live);
    live.pragma('locking_mode = EXCLUSIVE');
    live.exec('BEGIN EXCLUSIVE; COMMIT;');
    autoBackup(live, vaultPath, 'pre-restore', options);
    live.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    if (isBusy(error))
      throw new BackupError('the vault is in use; close BhavBook and try again', { cause: error });
    if (error instanceof VaultError) throw error;
    // Only a vault SQLite itself reports as corrupt may be replaced without a snapshot; any other failure (disk
    // full, permissions, a failed VACUUM) stops the restore so the current vault is never lost.
    if (!isCorrupt(error)) {
      throw new BackupError('could not back up the current vault before restoring; nothing was changed', {
        cause: error,
      });
    }
    keepRawCopy(vaultPath, options);
  } finally {
    live?.close();
  }
}

const SIDECARS = ['-wal', '-shm'] as const;

/** Moves the old vault (and any sidecars) aside, puts the staged file in place, and rolls back on failure. */
function swapIn(staged: string, vaultPath: string): void {
  const old = tempPath(vaultPath, 'old');
  const moved: [string, string][] = [];
  try {
    for (const suffix of ['', ...SIDECARS]) {
      if (!existsSync(`${vaultPath}${suffix}`)) continue;
      renameSync(`${vaultPath}${suffix}`, `${old}${suffix}`);
      moved.push([`${old}${suffix}`, `${vaultPath}${suffix}`]);
    }
    renameSync(staged, vaultPath);
  } catch (error) {
    for (const [from, to] of moved.reverse()) renameSync(from, to);
    throw error;
  }
  for (const [from] of moved) rmSync(from, { force: true });
}

export interface RestoreOptions extends BackupOptions {
  readonly migrations?: readonly Migration[];
}

/**
 * Restores a `.bhav` file over `vaultPath`. Nothing touches the live vault until the backup has been decoded,
 * checksummed, proven to be a BhavBook vault with exactly the expected schema, and migrated in a temp file.
 * Errors are BackupErrors with fixed messages; the underlying error is kept as `cause`.
 */
export function restoreBackup(
  file: string,
  vaultPath: string,
  options: RestoreOptions,
): { schemaVersion: number } {
  const migrations = options.migrations ?? loadMigrations();
  const staged = tempPath(vaultPath, 'restore');
  const rebuilt = tempPath(vaultPath, 'rebuilt');
  try {
    const { manifest, db: bytes } = decodeBhav(readBounded(file));
    if (manifest.schemaVersion < 1) throw new BackupError('backup manifest has an invalid schema version');
    if (manifest.schemaVersion > latestVersion(migrations)) {
      throw new BackupError('backup was made by a newer version of BhavBook; please upgrade');
    }
    if (!looksLikeSqlite(bytes) || bytes.length < SQLITE_MIN_PAGE || bytes.length % SQLITE_MIN_PAGE !== 0) {
      throw new BackupError('backup does not contain a SQLite database');
    }
    writeFileSync(staged, bytes, { flag: 'wx', mode: OWNER_ONLY_FILE });
    verifyStaged(staged, manifest.schemaVersion, migrations);
    rebuildFromBackup(staged, rebuilt, manifest.schemaVersion, migrations, options);
    retireLiveVault(vaultPath, options);
    swapIn(rebuilt, vaultPath);
    return { schemaVersion: latestVersion(migrations) };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError('restore failed; the current vault was not changed', { cause: error });
  } finally {
    for (const temp of [staged, rebuilt]) {
      for (const suffix of ['', ...SIDECARS]) rmSync(`${temp}${suffix}`, { force: true });
    }
  }
}
