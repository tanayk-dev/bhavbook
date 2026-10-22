import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireVaultLock, openVault, type RunningServer } from '@bhavbook/server';
import { checkNodeVersion, defaultVaultPath, main, type CliIo } from '../src/main.js';

let dir: string;
let vault: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bhavbook-cli-'));
  vault = path.join(dir, 'vault.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface FakeIo extends CliIo {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly opened: string[];
  /** Asks for a new launch link, as Enter does in the terminal. */
  requestLink(): void;
}

function fakeIo(
  options: { onRunning?: (server: RunningServer) => Promise<void>; openFails?: boolean } = {},
): FakeIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const opened: string[] = [];
  let onRequest: (() => void) | null = null;
  return {
    stdout,
    stderr,
    opened,
    requestLink: () => onRequest?.(),
    onNewLinkRequest: (listener) => {
      onRequest = listener;
      return () => {
        onRequest = null;
      };
    },
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    homedir: () => dir,
    openBrowser: (url) => {
      opened.push(url);
      return options.openFails ? Promise.reject(new Error('no browser')) : Promise.resolve();
    },
    waitForShutdown: (server) => options.onRunning?.(server) ?? Promise.resolve(),
  };
}

function makeVault(): void {
  openVault(vault, { appVersion: 'test' }).close();
}

describe('helpers', () => {
  it('defaults the vault to ~/BhavBook/vault.db', () => {
    expect(defaultVaultPath(dir)).toBe(path.join(dir, 'BhavBook', 'vault.db'));
  });

  it.each([
    ['24.11.0', true],
    ['24.22.0', true],
    ['25.0.0', true],
    ['24.10.9', false],
    ['22.20.0', false],
    ['garbage', false],
  ])('checkNodeVersion(%s) is %s', (version, ok) => {
    expect(checkNodeVersion(version)).toBe(ok);
  });
});

describe('arguments', () => {
  it.each([
    [['--port', 'abc']],
    [['--port', '70000']],
    [['frobnicate']],
    [['--nope']],
    [['backup']],
    [['restore']],
  ])('rejects %j with usage and exit code 2', async (argv) => {
    const io = fakeIo();
    expect(await main(argv, io)).toBe(2);
    expect(io.stderr.join('\n')).toMatch(/usage/i);
  });

  it('prints help with exit code 0', async () => {
    const io = fakeIo();
    expect(await main(['--help'], io)).toBe(0);
    expect(io.stdout.join('\n')).toMatch(/usage/i);
  });
});

describe('bhavbook (serve)', () => {
  it('creates the vault, serves on 127.0.0.1, opens the tokened URL and releases the lock on shutdown', async () => {
    let seenLock = false;
    const io = fakeIo({
      onRunning: async (server) => {
        seenLock = existsSync(`${vault}.lock`);
        const launch = await fetch(server.url, { redirect: 'manual' });
        expect(launch.status).toBe(302);
      },
    });
    expect(await main(['--vault', vault, '--port', '0'], io)).toBe(0);
    expect(seenLock).toBe(true);
    expect(existsSync(vault)).toBe(true);
    expect(existsSync(`${vault}.lock`)).toBe(false);
    expect(io.opened).toHaveLength(1);
    expect(io.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{43}$/);
    expect(io.stdout.join('\n')).toContain(io.opened[0]);
  });

  it('hands out a new one-time link on request; the spent one stays spent', async () => {
    let fresh = '';
    const io: FakeIo = fakeIo({
      onRunning: async (server) => {
        expect((await fetch(server.url, { redirect: 'manual' })).status).toBe(302);
        io.requestLink();
        fresh = io.opened.at(-1) ?? '';
        expect(fresh).not.toBe(server.url);
        expect((await fetch(server.url, { redirect: 'manual' })).status).toBe(401);
        expect((await fetch(fresh, { redirect: 'manual' })).status).toBe(302);
      },
    });
    expect(await main(['--vault', vault, '--port', '0'], io)).toBe(0);
    expect(io.opened).toHaveLength(2);
    expect(io.stdout.join('\n')).toContain(`New link: ${fresh}`);
    expect(io.stdout.join('\n')).toMatch(/press Enter here for a new one/);
  });

  it('uses the default vault under the home directory', async () => {
    expect(await main(['--port', '0'], fakeIo())).toBe(0);
    expect(existsSync(path.join(dir, 'BhavBook', 'vault.db'))).toBe(true);
  });

  it('keeps serving when the browser cannot be opened, and says how to open it', async () => {
    const io = fakeIo({ openFails: true });
    expect(await main(['--vault', vault, '--port', '0'], io)).toBe(0);
    expect(io.stderr.join('\n')).toMatch(/open .* in your browser/i);
  });

  it('refuses to start while another process holds the vault', async () => {
    const lock = acquireVaultLock(vault);
    try {
      const io = fakeIo();
      expect(await main(['--vault', vault, '--port', '0'], io)).toBe(1);
      expect(io.stderr.join('\n')).toMatch(/in use by another BhavBook process/);
    } finally {
      lock.release();
    }
  });

  it('recovers a vault left aside by a restore that crashed mid-swap', async () => {
    makeVault();
    renameSync(vault, path.join(dir, '.vault.db.old-a1b2c3d4e5f6.tmp'));
    const io = fakeIo();
    expect(await main(['--vault', vault, '--port', '0'], io)).toBe(0);
    expect(existsSync(vault)).toBe(true);
    expect(existsSync(path.join(dir, '.vault.db.old-a1b2c3d4e5f6.tmp'))).toBe(false);
    expect(io.stderr.join('\n')).toMatch(/recovered/i);
  });
});

describe('backup and restore', () => {
  it('backs up and restores a vault', async () => {
    makeVault();
    const out = path.join(dir, 'snap.bhav');
    const io = fakeIo();
    expect(await main(['backup', out, '--vault', vault], io)).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(await main(['restore', out, '--vault', vault], io)).toBe(0);
    expect(io.stdout.join('\n')).toMatch(/restored/i);
    expect(existsSync(`${vault}.lock`)).toBe(false);
  });

  it('refuses to back up a vault that does not exist (instead of creating one)', async () => {
    const io = fakeIo();
    expect(await main(['backup', path.join(dir, 'x.bhav'), '--vault', vault], io)).toBe(1);
    expect(existsSync(vault)).toBe(false);
  });

  it('refuses to restore while the vault is open elsewhere', async () => {
    makeVault();
    const out = path.join(dir, 'snap.bhav');
    expect(await main(['backup', out, '--vault', vault], fakeIo())).toBe(0);
    const lock = acquireVaultLock(vault);
    try {
      const io = fakeIo();
      expect(await main(['restore', out, '--vault', vault], io)).toBe(1);
      expect(io.stderr.join('\n')).toMatch(/in use/);
    } finally {
      lock.release();
    }
  });

  it('reports a bad backup file with the fixed error message only', async () => {
    makeVault();
    const bad = path.join(dir, 'bad.bhav');
    writeFileSync(bad, 'MARKER-not-a-backup');
    const io = fakeIo();
    expect(await main(['restore', bad, '--vault', vault], io)).toBe(1);
    expect(io.stderr.join('\n')).not.toContain('MARKER');
  });
});

describe('doctor', () => {
  it('passes on a healthy setup and skips a vault that does not exist yet', async () => {
    const io = fakeIo();
    expect(await main(['doctor', '--vault', vault], io)).toBe(0);
    const text = io.stdout.join('\n');
    expect(text).toMatch(/ok\s+node/i);
    expect(text).toMatch(/ok\s+sqlite/i);
    expect(text).toMatch(/skip\s+vault/i);
    // The schema the vault would be migrated to is readable (the bundle carries the migration files).
    expect(text).toMatch(/ok\s+schema: \d+ migrations/i);
    // Run from source, the web build is optional (it is built for the E2E and the package); in the package it is not.
    expect(text).toMatch(/(ok|skip)\s+web/i);
  });

  it('checks the integrity of an existing vault', async () => {
    makeVault();
    const io = fakeIo();
    expect(await main(['doctor', '--vault', vault], io)).toBe(0);
    expect(io.stdout.join('\n')).toMatch(/ok\s+vault/i);
  });

  it('fails on a corrupt vault', async () => {
    writeFileSync(vault, Buffer.alloc(8192, 7));
    const io = fakeIo();
    expect(await main(['doctor', '--vault', vault], io)).toBe(1);
    expect(io.stdout.join('\n')).toMatch(/fail\s+vault/i);
  });
});
