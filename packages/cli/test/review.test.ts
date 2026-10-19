// S11 review follow-ups: backups never clobber files (least of all the vault), backup works read-only beside a
// running server, and the real entry point runs as a process.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireVaultLock, openVault } from '@bhavbook/server';
import { main, type CliIo } from '../src/main.js';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

let dir: string;
let vault: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bhavbook-cli-review-'));
  vault = path.join(dir, 'vault.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function io(): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    homedir: () => dir,
    openBrowser: () => Promise.resolve(),
    waitForShutdown: () => Promise.resolve(),
  };
}

describe('backup safety', () => {
  it('refuses to overwrite an existing file unless --force is given', async () => {
    openVault(vault, { appVersion: 'test' }).close();
    const out = path.join(dir, 'notes.txt');
    writeFileSync(out, 'precious');
    const first = io();
    expect(await main(['backup', out, '--vault', vault], first)).toBe(1);
    expect(first.stderr.join('\n')).toMatch(/already exists/);
    expect(readFileSync(out, 'utf8')).toBe('precious');
    expect(await main(['backup', out, '--vault', vault, '--force'], io())).toBe(0);
  });

  it.each(['', '-wal', '-shm', '.lock'])(
    'never writes a backup over the vault%s, even with --force',
    async (suffix) => {
      openVault(vault, { appVersion: 'test' }).close();
      const target = `${vault}${suffix}`;
      if (!existsSync(target)) writeFileSync(target, 'x');
      const before = readFileSync(target);
      const result = io();
      expect(await main(['backup', target, '--vault', vault, '--force'], result)).toBe(1);
      expect(result.stderr.join('\n')).toMatch(/vault/);
      expect(readFileSync(target)).toEqual(before);
    },
  );

  it('backs up read-only while another process holds the vault lock', async () => {
    openVault(vault, { appVersion: 'test' }).close();
    const lock = acquireVaultLock(vault);
    try {
      expect(await main(['backup', path.join(dir, 'b.bhav'), '--vault', vault], io())).toBe(0);
    } finally {
      lock.release();
    }
  });

  it('refuses to back up a file that is not a BhavBook vault', async () => {
    writeFileSync(vault, Buffer.alloc(8192));
    expect(await main(['backup', path.join(dir, 'b.bhav'), '--vault', vault], io())).toBe(1);
  });
});

describe('arguments', () => {
  it('prints help even when other options are invalid', async () => {
    const result = io();
    expect(await main(['--help', '--port', 'abc'], result)).toBe(0);
    expect(result.stdout.join('\n')).toMatch(/usage/i);
  });
});

describe('the real entry point', () => {
  const tsx = ['--import', 'tsx', ENTRY];

  it('runs as a process and prints help', () => {
    const result = spawnSync(process.execPath, [...tsx, '--help'], { cwd: ROOT, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/usage/i);
  });

  it.skipIf(process.platform === 'win32')(
    'shuts down cleanly on SIGTERM, closing the server and releasing the lock',
    async () => {
      const child = spawn(process.execPath, [...tsx, '--vault', vault, '--no-open'], { cwd: ROOT });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('server did not start'));
        }, 30_000);
        child.stdout.on('data', () => {
          if (stdout.includes('running at')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      expect(existsSync(`${vault}.lock`)).toBe(true);
      child.kill('SIGTERM');
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      expect(code).toBe(0);
      expect(existsSync(`${vault}.lock`)).toBe(false);
    },
    60_000,
  );
});
