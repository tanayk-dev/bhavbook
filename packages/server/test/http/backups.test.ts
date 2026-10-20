// S13a-3b-2: backups over HTTP. A manual backup lands in `<vault>.backups/` and is listed with the automatic ones;
// a listed backup downloads as a `.bhav` file; a restore (a listed backup, or an uploaded file) closes the live
// vault, swaps the backup in and reopens it. A bad file leaves the vault as it was and says why with a fixed code.
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { restoreErrorCode, type BackupHost } from '../../src/http/backups.js';
import { BackupError, openVault } from '../../src/vault/index.js';
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

async function withBackups(run: (h: Harness, db: Database.Database) => Promise<void>): Promise<void> {
  await withVault(async ({ db, vaultPath }) => {
    const h = harness(db, vaultPath);
    try {
      await run(h, db);
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

describe('restore error codes', () => {
  it('maps each fixed backup message to what the person can do about it', () => {
    const cases: [string, string][] = [
      ['the vault is in use; close BhavBook and try again', 'in_use'],
      ['backup was made by a newer version of BhavBook; please upgrade', 'newer_version'],
      ['backup file is too large', 'too_large'],
      ['not a BhavBook backup (bad header)', 'not_a_backup'],
      ['backup manifest is not valid JSON', 'not_a_backup'],
      ['backup checksum does not match; the file is corrupted', 'corrupt'],
      ['backup database has an unexpected schema (extra or altered objects)', 'corrupt'],
      ['could not back up the current vault before restoring; nothing was changed', 'restore_failed'],
    ];
    for (const [message, code] of cases) expect(restoreErrorCode(new BackupError(message))).toBe(code);
    expect(restoreErrorCode(new Error('backup file is too large'))).toBe('restore_failed');
  });
});
