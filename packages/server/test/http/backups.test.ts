// S13a-3b-2: backups over HTTP. A manual backup lands in `<vault>.backups/` and is listed with the automatic ones;
// a listed backup downloads as a `.bhav` file; a restore (a listed backup, or an uploaded file) closes the live
// vault, swaps the backup in and reopens it. A bad file leaves the vault as it was and says why with a fixed code.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { BusyError, ReopenError, restoreErrorCode, type BackupHost } from '../../src/http/backups.js';
import { BackupError, listBackups, openVault } from '../../src/vault/index.js';
import { withVault } from '../import/helpers.js';
import { send, testApp, type TestApp } from './helpers.js';

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

interface Harness {
  readonly test: TestApp;
  /** Connections opened by restores; closed by the caller. */
  readonly opened: Database.Database[];
}

function harness(db: Database.Database, vaultPath: string): Harness {
  const opened: Database.Database[] = [];
  const backups: BackupHost = {
    vaultPath,
    appVersion: 'test',
    reopen: () => openVault(vaultPath, { appVersion: 'test' }),
    onReopen: (next) => opened.push(next),
  };
  return { test: testApp({ backups }, db), opened };
}

async function withBackups(
  run: (h: Harness, db: Database.Database, vaultPath: string) => Promise<void>,
): Promise<void> {
  await withVault(async ({ db, vaultPath }) => {
    const h = harness(db, vaultPath);
    try {
      await run(h, db, vaultPath);
    } finally {
      for (const connection of h.opened) connection.close();
    }
  });
}

interface Entry {
  name: string;
  kind: string;
  reason: string;
  createdAt: string;
  bytes: number;
}

async function backups(test: TestApp): Promise<Entry[]> {
  return ((await (await send(test, '/api/vault/backups')).json()) as { backups: Entry[] }).backups;
}

async function profileNames(test: TestApp): Promise<string[]> {
  const body = (await (await send(test, '/api/profiles')).json()) as { profiles: { name: string }[] };
  return body.profiles.map((profile) => profile.name);
}

async function backUp(test: TestApp): Promise<Entry> {
  const response = await send(test, '/api/vault/backup', { method: 'POST' });
  expect(response.status).toBe(201);
  return (await response.json()) as Entry;
}

const addProfile = (test: TestApp, name: string) => send(test, '/api/profiles', json('POST', { name }));

describe('backups', () => {
  it('writes a manual backup, lists it newest first, and downloads it as a .bhav file', async () => {
    await withBackups(async ({ test }) => {
      expect(await backups(test)).toEqual([]);
      const first = await backUp(test);
      expect(first).toMatchObject({ kind: 'manual', reason: 'manual' });
      expect(first.name).toMatch(/^backup-\d{8}T\d{9}Z-manual(-\d+)?\.bhav$/);
      expect(first.bytes).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(first.createdAt))).toBe(false);
      const second = await backUp(test);
      expect((await backups(test)).map((entry) => entry.name)).toEqual([second.name, first.name]);

      const download = await send(test, `/api/vault/backups/${first.name}`);
      expect(download.status).toBe(200);
      expect(download.headers.get('content-type')).toBe('application/octet-stream');
      expect(download.headers.get('content-disposition')).toBe(
        `attachment; filename="bhavbook-${first.name}"`,
      );
      expect(download.headers.get('cache-control')).toBe('no-store');
      const bytes = Buffer.from(await download.arrayBuffer());
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('BHAV');
      expect(bytes.length).toBe(first.bytes);
    });
  });

  it('restores a listed backup over the live vault, keeping a backup of what it replaced', async () => {
    await withBackups(async ({ test }) => {
      const saved = await backUp(test);
      expect((await addProfile(test, 'Long-term')).status).toBe(201);
      expect(await profileNames(test)).toEqual(['Swing', 'Long-term']);

      const response = await send(test, '/api/vault/restore', json('POST', { name: saved.name }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ schemaVersion: expect.any(Number) as number });
      expect(await profileNames(test)).toEqual(['Swing']);
      expect((await send(test, '/api/vault')).status).toBe(200);
      expect((await backups(test)).map((entry) => entry.reason)).toContain('pre-restore');
      // The reopened vault takes writes.
      expect((await addProfile(test, 'Intraday')).status).toBe(201);
    });
  });

  it('restores an uploaded backup, and refuses a file that is not one without touching the vault', async () => {
    await withBackups(async ({ test }) => {
      const saved = await backUp(test);
      const bytes = Buffer.from(await (await send(test, `/api/vault/backups/${saved.name}`)).arrayBuffer());
      await addProfile(test, 'Long-term');
      const upload = (body: Buffer, type = 'application/octet-stream') =>
        send(test, '/api/vault/restore/upload', { method: 'POST', headers: { 'content-type': type }, body });

      const garbage = await upload(Buffer.from('not a backup at all'));
      expect([garbage.status, await garbage.json()]).toEqual([422, { error: 'not_a_backup' }]);
      const corrupt = Buffer.from(bytes);
      corrupt[corrupt.length - 1] = (corrupt.at(-1) ?? 0) ^ 0xff;
      const damaged = await upload(corrupt);
      expect([damaged.status, await damaged.json()]).toEqual([422, { error: 'corrupt' }]);
      expect((await upload(bytes, 'application/json')).status).toBe(415);
      expect(await profileNames(test)).toEqual(['Swing', 'Long-term']);

      expect((await upload(bytes)).status).toBe(200);
      expect(await profileNames(test)).toEqual(['Swing']);
    });
  });

  it('only resolves names it made itself', async () => {
    await withBackups(async ({ test }) => {
      const replies = [
        await send(test, '/api/vault/backups/backup-20261020T120000000Z-manual.bhav'),
        await send(test, '/api/vault/backups/vault.db'),
        await send(test, '/api/vault/backups/..%2Fvault.db.bhav'),
        await send(test, '/api/vault/restore', json('POST', { name: '../vault.db' })),
        await send(test, '/api/vault/restore', json('POST', { name: 'raw-20261020T120000000Z-x.db' })),
      ];
      expect(replies.map((reply) => reply.status)).toEqual([404, 400, 400, 404, 404]);
    });
  });

  it('answers 503 without a vault or without a backup host', async () => {
    await withVault(async ({ db }) => {
      const noHost = testApp({}, db);
      expect((await send(noHost, '/api/vault/backups')).status).toBe(503);
      expect((await send(noHost, '/api/vault/backup', { method: 'POST' })).status).toBe(503);
    });
  });
});

describe('restore failures', () => {
  it('answers 409 when another connection holds the vault, and keeps serving the untouched vault', async () => {
    await withBackups(async ({ test }, _db, vaultPath) => {
      const saved = await backUp(test);
      const other = new Database(vaultPath);
      try {
        other.exec('BEGIN IMMEDIATE');
        const response = await send(test, '/api/vault/restore', json('POST', { name: saved.name }));
        expect([response.status, await response.json()]).toEqual([409, { error: 'in_use' }]);
        other.exec('ROLLBACK');
      } finally {
        other.close();
      }
      expect(await profileNames(test)).toEqual(['Swing']);
      expect((await addProfile(test, 'Long-term')).status).toBe(201);
    });
  });

  it('reports a vault that cannot be reopened, and recovers on a later request', async () => {
    await withVault(async ({ db, vaultPath }) => {
      const opened: Database.Database[] = [];
      let failures = 1;
      const backups: BackupHost = {
        vaultPath,
        appVersion: 'test',
        reopen: () => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('locked by antivirus');
          }
          const next = openVault(vaultPath, { appVersion: 'test' });
          opened.push(next);
          return next;
        },
      };
      const test = testApp({ backups }, db);
      try {
        const saved = await backUp(test);
        const response = await send(test, '/api/vault/restore', json('POST', { name: saved.name }));
        expect([response.status, await response.json()]).toEqual([503, { error: 'reopen_failed' }]);
        expect(await profileNames(test)).toEqual(['Swing']);
      } finally {
        for (const connection of opened) connection.close();
      }
    });
  });
});

describe('listing order', () => {
  it('puts the newest first, a higher collision counter first within a millisecond, then by name', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bhavbook-catalog-'));
    try {
      const vaultPath = path.join(dir, 'vault.db');
      mkdirSync(`${vaultPath}.backups`);
      const names = [
        'auto-20261020T120000000Z-pre-import.bhav',
        'auto-20261020T120000000Z-pre-import-2.bhav',
        'auto-20261020T120000000Z-pre-import-10.bhav',
        'backup-20261020T120000000Z-manual.bhav',
        'auto-20261019T120000000Z-pre-undo.bhav',
        'raw-20261020T120000000Z-pre-restore-raw.db',
        '.upload-abc.tmp',
      ];
      for (const name of names) writeFileSync(path.join(`${vaultPath}.backups`, name), 'x');
      expect(listBackups(vaultPath).map((entry) => entry.name)).toEqual([
        'auto-20261020T120000000Z-pre-import-10.bhav',
        'auto-20261020T120000000Z-pre-import-2.bhav',
        'auto-20261020T120000000Z-pre-import.bhav',
        'backup-20261020T120000000Z-manual.bhav',
        'auto-20261019T120000000Z-pre-undo.bhav',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('restore error codes', () => {
  it('uses the problem each backup error carries, and the reopen and busy cases', () => {
    expect(restoreErrorCode(new BackupError('x', { problem: 'corrupt' }))).toBe('corrupt');
    expect(restoreErrorCode(new BackupError('x'))).toBe('restore_failed');
    expect(restoreErrorCode(new ReopenError('x'))).toBe('reopen_failed');
    expect(restoreErrorCode(new BusyError('x'))).toBe('busy');
    expect(restoreErrorCode(new Error('backup file is too large'))).toBe('restore_failed');
  });
});
