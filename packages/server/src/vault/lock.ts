// Single-instance vault lock (S4 review): `<vault>.lock`, created with O_EXCL and holding the owner's PID, is held
// for the server's lifetime and for a whole restore, so a second `npx bhavbook` or a restore can't touch an open
// vault.
//
// A lock is stale when its PID no longer runs, or when it is empty/unreadable and older than STALE_LOCK_MS (its
// owner crashed before writing the PID). Taking over a stale lock is serialised through `<lock>.takeover`
// (also O_EXCL), and staleness is re-checked while holding it: without that, two processes that both saw the
// same dead lock could each delete the other's fresh one.
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { VaultError } from './errors.js';

const OWNER_ONLY_FILE = 0o600;

/** How old an empty or unreadable lock (or takeover marker) must be before it counts as abandoned. */
export const STALE_LOCK_MS = 10_000;

export interface VaultLock {
  readonly path: string;
  /** Removes the lock if it is still ours. Safe to call more than once. */
  release(): void;
}

export function lockPath(vaultPath: string): string {
  return `${vaultPath}.lock`;
}

function inUse(file: string): VaultError {
  return new VaultError(`the vault is in use by another BhavBook process (lock file: ${file})`);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The PID in a lock file, or null when the file is missing, unreadable or not a PID. */
function ownerOf(file: string): number | null {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return /^\d{1,10}$/.test(text) ? Number.parseInt(text, 10) : null;
  } catch {
    return null;
  }
}

/** Milliseconds since the file was last modified; Infinity when it is gone. */
function ageOf(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isStale(file: string): boolean {
  const owner = ownerOf(file);
  if (owner === null) return ageOf(file) > STALE_LOCK_MS;
  return owner !== process.pid && owner > 0 && !isRunning(owner);
}

/** Creates `file` exclusively with `content`; false when it already exists. */
function tryCreate(file: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx', OWNER_ONLY_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw new VaultError('could not create the vault lock file', { cause: error });
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Replaces a stale lock with ours, one process at a time. */
function takeOver(file: string, pid: string): void {
  const marker = `${file}.takeover`;
  if (!tryCreate(marker, pid)) {
    // A takeover that crashed leaves its marker behind; it is abandoned once old enough.
    if (ageOf(marker) <= STALE_LOCK_MS) throw inUse(file);
    rmSync(marker, { force: true });
    if (!tryCreate(marker, pid)) throw inUse(file);
  }
  try {
    if (!isStale(file)) throw inUse(file);
    rmSync(file, { force: true });
    if (!tryCreate(file, pid)) throw inUse(file);
  } finally {
    rmSync(marker, { force: true });
  }
}

export function acquireVaultLock(vaultPath: string): VaultLock {
  const file = lockPath(vaultPath);
  const pid = `${String(process.pid)}\n`;
  if (!tryCreate(file, pid)) {
    if (!isStale(file)) throw inUse(file);
    takeOver(file, pid);
  }
  let held = true;
  return {
    path: file,
    release() {
      if (!held) return;
      held = false;
      if (ownerOf(file) === process.pid) rmSync(file, { force: true });
    },
  };
}
