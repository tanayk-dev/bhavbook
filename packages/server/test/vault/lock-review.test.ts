// S11 review follow-ups for the vault lock: a real multi-process race on a stale lock, abandoned empty locks,
// and errors that say which file to look at.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { acquireVaultLock, lockPath, STALE_LOCK_MS } from '../../src/vault/index.js';
import { withTempDir } from './helpers.js';

// An ESM specifier must be a file:// URL (a bare Windows path like C:\... is read as a URL scheme).
const LOCK_MODULE = pathToFileURL(fileURLToPath(new URL('../../src/vault/lock.ts', import.meta.url))).href;
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function age(file: string, ms: number): void {
  const past = new Date(Date.now() - ms);
  utimesSync(file, past, past);
}

describe('vault lock: review follow-ups', () => {
  it('names the lock file in the in-use error', () => {
    withTempDir((dir) => {
      const vault = path.join(dir, 'vault.db');
      const lock = acquireVaultLock(vault);
      try {
        expect(() => acquireVaultLock(vault)).toThrow(lockPath(vault));
      } finally {
        lock.release();
      }
    });
  });

  it('takes over an empty or unreadable lock once it is older than the stale window', () => {
    withTempDir((dir) => {
      const vault = path.join(dir, 'vault.db');
      for (const content of ['', 'garbage']) {
        writeFileSync(lockPath(vault), content);
        age(lockPath(vault), STALE_LOCK_MS + 1_000);
        const lock = acquireVaultLock(vault);
        expect(readFileSync(lockPath(vault), 'utf8').trim()).toBe(String(process.pid));
        lock.release();
      }
    });
  });

  it('respects a fresh empty lock (its owner may be writing its PID right now)', () => {
    withTempDir((dir) => {
      const vault = path.join(dir, 'vault.db');
      writeFileSync(lockPath(vault), '');
      expect(() => acquireVaultLock(vault)).toThrow(/in use/);
    });
  });

  it('lets exactly one of several processes racing for a stale lock win', async () => {
    await withTempDir(async (dir) => {
      const vault = path.join(dir, 'vault.db');
      writeFileSync(lockPath(vault), `${String(spawnSync(process.execPath, ['-e', '']).pid)}\n`);
      age(lockPath(vault), STALE_LOCK_MS + 1_000);
      const go = path.join(dir, 'go');
      const script = `
        import { existsSync } from 'node:fs';
        import { acquireVaultLock } from ${JSON.stringify(LOCK_MODULE)};
        process.stdout.write('ready\\n');
        while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 5));
        try {
          const lock = acquireVaultLock(${JSON.stringify(vault)});
          process.stdout.write('won\\n');
          await new Promise((r) => setTimeout(r, 1500));
          lock.release();
        } catch {
          process.stdout.write('lost\\n');
        }`;
      const children = Array.from({ length: 6 }, () =>
        spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: ROOT }),
      );
      const outputs = children.map(
        (child) =>
          new Promise<string>((resolve) => {
            let text = '';
            child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString()));
            child.on('close', () => {
              resolve(text);
            });
          }),
      );
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              child.stdout.once('data', () => {
                resolve();
              });
              // A child that dies before it is ready must fail the test, not hang it.
              child.once('close', () => {
                resolve();
              });
            }),
        ),
      );
      writeFileSync(go, '');
      const results = await Promise.all(outputs);
      expect(results.filter((text) => text.includes('won'))).toHaveLength(1);
      expect(results.filter((text) => text.includes('lost'))).toHaveLength(5);
      expect(existsSync(lockPath(vault))).toBe(false);
    });
  }, 60_000);
});
