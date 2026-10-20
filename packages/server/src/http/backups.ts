// Backups and restore over HTTP (S13a-3b-2, ADR-0020). The server holds the vault open, and a restore needs it
// closed (restoreBackup takes an exclusive lock and swaps the file), so a restore closes the live connection,
// restores, and reopens whichever vault is then on disk: the backup's on success, the untouched one on failure.
// The restore itself is synchronous, so no other request runs in between; one restore runs at a time. Errors are
// fixed codes (ADR-0019).
import { randomBytes } from 'node:crypto';
import { createWriteStream, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type Database from 'better-sqlite3';
import {
  BackupError,
  ensureBackupDir,
  MAX_BACKUP_BYTES,
  restoreBackup,
  type BackupProblem,
} from '../vault/index.js';

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
  /** Tries to open the vault again when a restore could not (null: nothing to retry with). */
  recover: (() => void) | null;
  /** True while an upload restore streams its body; another restore waits for it to finish. */
  restoring: boolean;
}

export type RestoreErrorCode = Exclude<BackupProblem, 'failed'> | 'reopen_failed' | 'busy' | 'restore_failed';

/** The vault could not be opened again after a restore; requests retry it, and a restart always does. */
export class ReopenError extends Error {
  override readonly name = 'ReopenError';
}

/** Another restore is running. */
export class BusyError extends Error {
  override readonly name = 'BusyError';
}

export function restoreErrorCode(error: unknown): RestoreErrorCode {
  if (error instanceof ReopenError) return 'reopen_failed';
  if (error instanceof BusyError) return 'busy';
  if (!(error instanceof BackupError) || error.problem === 'failed') return 'restore_failed';
  return error.problem;
}

/** Opens the vault into `live`; false when it cannot be opened. */
export function reopenLive(live: LiveVault, host: BackupHost): boolean {
  try {
    const next = host.reopen();
    live.db = next;
    host.onReopen?.(next);
    return true;
  } catch {
    return false;
  }
}

export function liveVault(db: Database.Database | null, host: BackupHost | undefined): LiveVault {
  const live: LiveVault = { db, recover: null, restoring: false };
  if (host !== undefined) {
    live.recover = () => {
      reopenLive(live, host);
    };
  }
  return live;
}

/**
 * Restores `file` over the live vault and reopens it. Throws the restore's BackupError (the vault on disk is
 * unchanged) or, when the vault cannot be opened again afterwards, a ReopenError.
 */
export function restoreLive(live: LiveVault, host: BackupHost, file: string): { schemaVersion: number } {
  live.db?.close();
  live.db = null;
  let outcome: { readonly schemaVersion: number } | { readonly error: unknown };
  try {
    outcome = restoreBackup(file, host.vaultPath, { appVersion: host.appVersion });
  } catch (error) {
    outcome = { error };
  }
  if (!reopenLive(live, host)) throw new ReopenError('the vault could not be opened after a restore');
  if ('error' in outcome) throw outcome.error;
  return outcome;
}

const UPLOAD_PREFIX = '.upload-';

/** Upload staging files left by a process that stopped mid-restore (only one restore runs at a time). */
function sweepUploads(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(UPLOAD_PREFIX) && name.endsWith('.tmp'))
      rmSync(path.join(dir, name), { force: true });
  }
}

/** The web package typechecks this file with DOM types, where the global ReadableStream is a different type. */
function fromWeb(body: ReadableStream<Uint8Array>): Readable {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
}

/** Counts bytes through the stream and fails it past the cap. */
function capped(limit: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      total += chunk.length;
      if (total > limit) done(new BackupError('backup file is too large', { problem: 'too_large' }));
      else done(null, chunk);
    },
  });
}

/**
 * Restores from an uploaded body, streamed owner-only into the backup directory (never held in memory) and
 * removed afterwards. A second restore while one runs is refused (`busy`).
 */
export async function restoreUpload(
  live: LiveVault,
  host: BackupHost,
  body: ReadableStream<Uint8Array> | null,
): Promise<{ schemaVersion: number }> {
  if (live.restoring) throw new BusyError();
  live.restoring = true;
  const dir = ensureBackupDir(host.vaultPath);
  const staged = path.join(dir, `${UPLOAD_PREFIX}${randomBytes(6).toString('hex')}.tmp`);
  try {
    sweepUploads(dir);
    const source = body === null ? Readable.from([]) : fromWeb(body);
    await pipeline(source, capped(MAX_BACKUP_BYTES), createWriteStream(staged, { flags: 'wx', mode: 0o600 }));
    return restoreLive(live, host, staged);
  } finally {
    rmSync(staged, { force: true });
    live.restoring = false;
  }
}

/** A restore of a listed backup, refused while an upload restore is in flight. */
export function restoreListed(live: LiveVault, host: BackupHost, file: string): { schemaVersion: number } {
  if (live.restoring) throw new BusyError();
  return restoreLive(live, host, file);
}
