// S13b-1: imports over HTTP (PRD §5.1). Preview real fixture files (multipart, names never sent), commit with the
// single-use token, re-import (all duplicates), the history, coverage, and undo; the account is recomputed after
// each change. The service follows the live vault, so a restore drops previews made against the old one.
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { BackupHost } from '../../src/http/backups.js';
import { openVault } from '../../src/vault/index.js';
import { count, DHAN, fixtureBytes, withVault, ZERODHA } from '../import/helpers.js';
import { send, testApp, type TestApp } from './helpers.js';

interface Harness {
  readonly test: TestApp;
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

async function withImports(run: (test: TestApp, db: Database.Database) => Promise<void>): Promise<void> {
  await withVault(async ({ db, vaultPath }) => {
    const { test, opened } = harness(db, vaultPath);
    try {
      await run(test, db);
    } finally {
      for (const connection of opened) connection.close();
    }
  });
}

function form(files: { broker: string; kind: string; hint?: string }[]): FormData {
  const body = new FormData();
  for (const file of files) {
    body.append('file', new Blob([fixtureBytes(file.broker, file.kind)]), 'upload');
    body.append('kind', file.hint ?? '');
  }
  return body;
}

interface Preview {
  token: string | null;
  expiresAt: string;
  files: {
    index: number;
    label: string | null;
    status: string;
    kind?: string;
    counts?: { rows: { new: number; duplicate: number } };
  }[];
}

async function preview(test: TestApp, accountId: string, body: FormData): Promise<Preview> {
  const response = await send(test, `/api/imports?accountId=${accountId}`, { method: 'POST', body });
  expect(response.status).toBe(200);
  return (await response.json()) as Preview;
}

const json = (method: string, value: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

describe('imports', () => {
  it('previews, commits, re-imports as duplicates, lists, covers and undoes, recomputing each time', async () => {
    await withImports(async (test, db) => {
      const first = await preview(test, DHAN, form([{ broker: 'dhan', kind: 'trade_history' }]));
      const [file] = first.files;
      expect(file).toMatchObject({ index: 0, label: null, status: 'ready', kind: 'dhan.trade_history' });
      const fresh = file?.counts?.rows.new ?? 0;
      expect(fresh).toBeGreaterThan(0);
      expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const committed = await send(test, '/api/imports/commit', json('POST', { token: first.token }));
      expect(committed.status).toBe(200);
      const { batches } = (await committed.json()) as {
        batches: { batchId: string; inserted: { rows: number } }[];
      };
      expect(batches.map((batch) => batch.inserted.rows)).toEqual([fresh]);
      expect(count(db, 'trade_row', `account_id = '${DHAN}'`)).toBe(fresh);
      expect(count(db, 'position', `account_id = '${DHAN}'`)).toBeGreaterThan(0);

      const again = await preview(test, DHAN, form([{ broker: 'dhan', kind: 'trade_history' }]));
      expect(again.files[0]?.counts?.rows).toEqual({ new: 0, duplicate: fresh });
      // Single use: the first token is spent.
      const reused = await send(test, '/api/imports/commit', json('POST', { token: first.token }));
      expect([reused.status, await reused.json()]).toEqual([410, { error: 'preview_expired' }]);

      const history = (await (await send(test, `/api/imports?accountId=${DHAN}`)).json()) as {
        imports: { id: string; kind: string; counts: { rows: { new: number } } }[];
      };
      expect(history.imports).toHaveLength(1);
      expect(history.imports[0]).toMatchObject({ id: batches[0]?.batchId, kind: 'dhan.trade_history' });
      expect(history.imports[0]?.counts.rows.new).toBe(fresh);

      const coverage = (await (await send(test, `/api/coverage?accountId=${DHAN}`)).json()) as {
        coverage: { kind: string; ranges: unknown[] }[];
      };
      expect(coverage.coverage.map((entry) => entry.kind)).toEqual(['dhan.trade_history']);

      const undone = await send(test, `/api/imports/${batches[0]?.batchId ?? ''}`, { method: 'DELETE' });
      expect(undone.status).toBe(200);
      expect(await undone.json()).toEqual({ accountId: DHAN, removed: { rows: fresh, statements: 0 } });
      expect(count(db, 'trade_row', `account_id = '${DHAN}'`)).toBe(0);
      expect(count(db, 'position', `account_id = '${DHAN}'`)).toBe(0);
      const after = (await (await send(test, `/api/imports?accountId=${DHAN}`)).json()) as {
        imports: unknown[];
      };
      expect(after.imports).toEqual([]);
    });
  });

  it('previews several files at once, each with its own status', async () => {
    await withImports(async (test) => {
      const result = await preview(
        test,
        ZERODHA,
        form([
          { broker: 'zerodha', kind: 'tradebook' },
          { broker: 'dhan', kind: 'trade_history' },
        ]),
      );
      expect(result.files.map((file) => [file.index, file.status])).toEqual([
        [0, 'ready'],
        [1, 'wrong_broker'],
      ]);
      expect(result.token).not.toBeNull();
    });
  });

  it('answers fixed codes for what the person can fix', async () => {
    await withImports(async (test) => {
      const unknownAccount = await send(test, '/api/imports?accountId=nope', {
        method: 'POST',
        body: form([{ broker: 'dhan', kind: 'trade_history' }]),
      });
      const replies = [
        unknownAccount,
        await send(test, '/api/imports?accountId=nope'),
        await send(test, `/api/imports?accountId=${DHAN}`, { method: 'POST', body: new FormData() }),
        await send(test, `/api/imports?accountId=${DHAN}`, json('POST', {})),
        await send(test, '/api/imports', { method: 'POST', body: form([]) }),
        await send(test, '/api/imports/commit', json('POST', { token: 'short' })),
        await send(test, '/api/imports/commit', json('POST', { token: 'a'.repeat(43) })),
        await send(test, '/api/imports/nope', { method: 'DELETE' }),
        await send(test, '/api/coverage?accountId=nope'),
      ];
      expect(await Promise.all(replies.map(async (reply) => [reply.status, await reply.json()]))).toEqual([
        [404, { error: 'not_found' }],
        [404, { error: 'not_found' }],
        [400, { error: 'no_files' }],
        [415, { error: 'unsupported_media_type' }],
        [400, { error: 'invalid_request' }],
        [400, { error: 'invalid_request' }],
        [410, { error: 'preview_expired' }],
        [404, { error: 'not_found' }],
        [404, { error: 'not_found' }],
      ]);
    });
  });

  it('refuses upload requests that break the contract, without a server error', async () => {
    await withImports(async (test) => {
      const target = `/api/imports?accountId=${DHAN}`;
      const unpaired = form([
        { broker: 'dhan', kind: 'trade_history' },
        { broker: 'dhan', kind: 'trade_history' },
      ]);
      unpaired.delete('kind');
      unpaired.append('kind', 'dhan.trade_history');
      const textPart = new FormData();
      textPart.append('file', 'not a file');
      const many = new FormData();
      for (let index = 0; index < 11; index += 1) many.append('file', new Blob(['x']), 'upload');
      const replies = [
        await send(test, target, { method: 'POST', body: unpaired }),
        await send(test, target, { method: 'POST', body: textPart }),
        await send(test, target, { method: 'POST', body: many }),
        await send(test, target, {
          method: 'POST',
          headers: { 'content-type': 'multipart/form-data; boundary=x' },
          body: 'garbage without any boundary',
        }),
      ];
      expect(await Promise.all(replies.map(async (reply) => [reply.status, await reply.json()]))).toEqual([
        [400, { error: 'invalid_request' }],
        [400, { error: 'invalid_request' }],
        [413, { error: 'too_many_files' }],
        [400, { error: 'invalid_request' }],
      ]);
    });
  });

  it('follows a restore: a preview made against the old vault cannot be committed into the new one', async () => {
    await withImports(async (test) => {
      const saved = (await (await send(test, '/api/vault/backup', { method: 'POST' })).json()) as {
        name: string;
      };
      const before = await preview(test, DHAN, form([{ broker: 'dhan', kind: 'trade_history' }]));
      expect((await send(test, '/api/vault/restore', json('POST', { name: saved.name }))).status).toBe(200);
      const stale = await send(test, '/api/imports/commit', json('POST', { token: before.token }));
      expect([stale.status, await stale.json()]).toEqual([410, { error: 'preview_expired' }]);
      const fresh = await preview(test, DHAN, form([{ broker: 'dhan', kind: 'trade_history' }]));
      expect((await send(test, '/api/imports/commit', json('POST', { token: fresh.token }))).status).toBe(
        200,
      );
    });
  });

  it('answers 503 without a vault host', async () => {
    await withVault(async ({ db }) => {
      expect((await send(testApp({}, db), `/api/imports?accountId=${DHAN}`)).status).toBe(503);
    });
  });
});
