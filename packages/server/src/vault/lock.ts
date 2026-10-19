// Single-instance vault lock (S4 review): `<vault>.lock`, created with O_EXCL and holding the owner's PID, is held
// for the server's lifetime and for a whole restore, so a second `npx bhavbook` or a restore can't touch an open
// vault. A lock whose PID no longer exists is stale and taken over; anything we can't prove stale is respected.
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { VaultError } from './errors.js';

const OWNER_ONLY_FILE = 0o600;

export interface VaultLock {
  readonly path: string;
  /** Removes the lock if it is still ours. Safe to call more than once. */
  release(): void;
}

export function lockPath(vaultPath: string): string {
  return `${vaultPath}.lock`;
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

function tryCreate(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx', OWNER_ONLY_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw new VaultError('could not create the vault lock file', { cause: error });
  }
  try {
    writeSync(fd, `${String(process.pid)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

export function acquireVaultLock(vaultPath: string): VaultLock {
  const file = lockPath(vaultPath);
  if (!tryCreate(file)) {
    const owner = ownerOf(file);
    const stale = owner !== null && owner !== process.pid && owner > 0 && !isRunning(owner);
    if (!stale) throw new VaultError('the vault is in use by another BhavBook process');
    rmSync(file, { force: true });
    if (!tryCreate(file)) throw new VaultError('the vault is in use by another BhavBook process');
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
