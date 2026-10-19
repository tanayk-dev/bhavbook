// Single-instance vault lock (S4 review): `<vault>.lock`, created exclusively, holding the owner's PID.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireVaultLock, lockPath, VaultError } from '../../src/vault/index.js';
import { withTempDir } from './helpers.js';

/** The PID of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid;
}

describe('acquireVaultLock', () => {
  it('creates the lock file with our PID and removes it on release', () => {
    withTempDir((dir) => {
      const vault = path.join(dir, 'vault.db');
      const lock = acquireVaultLock(vault);
      expect(lockPath(vault)).toBe(`${vault}.lock`);
      expect(readFileSync(lockPath(vault), 'utf8').trim()).toBe(String(process.pid));
      lock.release();
      expect(existsSync(lockPath(vault))).toBe(false);
    });
  });

  it('refuses a second lock while the first is held, with a fixed message', () => {
    withTempDir((dir) => {
      const vault = path.join(dir, 'vault.db');
      const lock = acquireVaultLock(vault);
      try {
        expect(() => acquireVaultLock(vault)).toThrow(VaultError);
        expect(() => acquireVaultLock(vault)).toThrow(/in use by another BhavBook process/);
      } finally {
        lock.release();
      }
      acquireVaultLock(vault).release();
    });
  });

  it('takes over a stale lock left by a process that no longer exists', () => {
    withTempDir((dir) => {
      const vault = path.join(dir, 'vault.db');
      writeFileSync(lockPath(vault), `${String(deadPid())}\n`);
      const lock = acquireVaultLock(vault);
      expect(readFileSync(lockPath(vault), 'utf8').trim()).toBe(String(process.pid));
      lock.release();
    });
  });

  it('treats an unreadable lock file as held (never deletes what it cannot prove stale)', () => {
    withTempDir((dir) => {
      const vault = path.join(dir, 'vault.db');
      writeFileSync(lockPath(vault), 'garbage');
      expect(() => acquireVaultLock(vault)).toThrow(VaultError);
      expect(existsSync(lockPath(vault))).toBe(true);
    });
  });

  it('release is idempotent and never removes a lock someone else now holds', () => {
    withTempDir((dir) => {
      const vault = path.join(dir, 'vault.db');
      const lock = acquireVaultLock(vault);
      lock.release();
      writeFileSync(lockPath(vault), '999999\n');
      lock.release();
      expect(readFileSync(lockPath(vault), 'utf8')).toBe('999999\n');
    });
  });
});
