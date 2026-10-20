// Backups and restore over HTTP (S13a-3b-2, ADR-0020). The server holds the vault open, and a restore needs it
// closed (restoreBackup takes an exclusive lock and swaps the file), so a restore closes the live connection,
// restores, and reopens whichever vault is then on disk: the backup's on success, the untouched one on failure.
// The work is synchronous, so no other request runs in between. Restore errors become fixed codes (ADR-0019).
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { BackupError, ensureBackupDir, restoreBackup } from '../vault/index.js';

export interface BackupHost {
  readonly vaultPath: string;
  readonly appVersion: string;
  /** Opens the vault at vaultPath again after a restore. */
  readonly reopen: () => Database.Database;
  /** Told about the connection now in use, so its owner can close it at shutdown. */
  readonly onReopen?: (db: Database.Database) => void;
}

/** The server's connection to the vault; replaced by a restore. */
export interface LiveVault {
  db: Database.Database | null;
}

export type RestoreErrorCode =
  'in_use' | 'newer_version' | 'not_a_backup' | 'corrupt' | 'too_large' | 'restore_failed';

/** BackupError messages are fixed strings (vault/backup.ts, container.ts); each maps to what the person can do. */
const RESTORE_ERRORS: readonly (readonly [RegExp, RestoreErrorCode])[] = [
  [/in use/, 'in_use'],
  [/newer version/, 'newer_version'],
  [/too large/, 'too_large'],
  [/bad header|not a BhavBook vault|does not contain a SQLite|manifest/, 'not_a_backup'],
  [
    /checksum|truncated|integrity|broken references|changed while|unexpected schema|migration history/,
    'corrupt',
  ],
];

export function restoreErrorCode(error: unknown): RestoreErrorCode {
  if (!(error instanceof BackupError)) return 'restore_failed';
  return RESTORE_ERRORS.find(([pattern]) => pattern.test(error.message))?.[1] ?? 'restore_failed';
}

/** Restores `file` over the live vault and reopens it. Throws BackupError (vault unchanged) or a reopen failure. */
export function restoreLive(live: LiveVault, host: BackupHost, file: string): { schemaVersion: number } {
  live.db?.close();
  live.db = null;
  try {
    return restoreBackup(file, host.vaultPath, { appVersion: host.appVersion });
  } finally {
    const next = host.reopen();
    live.db = next;
    host.onReopen?.(next);
  }
}

/** Restores from uploaded bytes, staged owner-only in the backup directory and removed afterwards. */
export function restoreUpload(
  live: LiveVault,
  host: BackupHost,
  bytes: Uint8Array,
): { schemaVersion: number } {
  const staged = path.join(ensureBackupDir(host.vaultPath), `.upload-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(staged, bytes, { flag: 'wx', mode: 0o600 });
    return restoreLive(live, host, staged);
  } finally {
    rmSync(staged, { force: true });
  }
}
