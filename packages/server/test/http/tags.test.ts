// S13a-3b-1: setup and mistake tags (PRD §4 settings, §10). Create, rename, delete and merge; names follow the
// profile-label rules and are unique per kind ignoring case. Deleting or merging never touches a journal entry
// beyond its tag links.
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { withVault, ZERODHA } from '../import/helpers.js';
import { send, testApp, type TestApp } from './helpers.js';

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function create(test: TestApp, kind: string, name: string): Promise<string> {
  const response = await send(test, '/api/tags', json('POST', { kind, name }));
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function list(test: TestApp): Promise<unknown> {
  return ((await (await send(test, '/api/tags')).json()) as { tags: unknown }).tags;
}

/** A journal entry with an optional setup tag and any number of linked tags. */
function entry(db: Database.Database, id: string, setupTagId: string | null, linked: string[] = []): void {
  db.prepare(
    `INSERT INTO journal_entry (id, anchor_account_id, anchor_instrument_key, anchor_bucket, anchor_key, status,
       setup_tag_id, created_at, updated_at)
     VALUES (?, ?, 'INE000000000', 'DELIVERY', ?, 'attached', ?, 'x', 'x')`,
  ).run(id, ZERODHA, `key-${id}`, setupTagId);
  for (const tagId of linked) {
    db.prepare('INSERT INTO journal_tag (journal_entry_id, tag_id) VALUES (?, ?)').run(id, tagId);
  }
}

describe('tags', () => {
  it('creates and lists tags by kind, then name, with how many journal entries use each', async () => {
    await withVault(async ({ db }) => {
      const test = testApp({}, db);
      const breakout = await create(test, 'setup', 'Breakout');
      const early = await create(test, 'mistake', 'Entered early');
      const base = await create(test, 'setup', '  base  ');
      entry(db, 'j1', breakout, [early]);
      entry(db, 'j2', breakout);
      expect(await list(test)).toEqual([
        { id: base, kind: 'setup', name: 'base', uses: 0 },
        { id: breakout, kind: 'setup', name: 'Breakout', uses: 2 },
        { id: early, kind: 'mistake', name: 'Entered early', uses: 1 },
      ]);
    });
  });

  it('keeps names unique per kind ignoring case, and refuses bad or identifier-shaped names', async () => {
    await withVault(async ({ db }) => {
      const test = testApp({}, db);
      await create(test, 'setup', 'Breakout');
      await create(test, 'mistake', 'breakout');
      const replies = [
        await send(test, '/api/tags', json('POST', { kind: 'setup', name: 'BREAKOUT' })),
        await send(test, '/api/tags', json('POST', { kind: 'setup', name: '   ' })),
        await send(test, '/api/tags', json('POST', { kind: 'setup', name: 'ABCDE1234F' })),
        await send(test, '/api/tags', json('POST', { kind: 'habit', name: 'Late' })),
        await send(test, '/api/tags', json('POST', { kind: 'setup', name: 'x'.repeat(41) })),
      ];
      expect(await Promise.all(replies.map(async (r) => [r.status, await r.json()]))).toEqual([
        [409, { error: 'conflict' }],
        [400, { error: 'invalid' }],
        [400, { error: 'identifier' }],
        [400, { error: 'invalid_request' }],
        [400, { error: 'invalid' }],
      ]);
    });
  });

  it('renames a tag under the same rules', async () => {
    await withVault(async ({ db }) => {
      const test = testApp({}, db);
      const breakout = await create(test, 'setup', 'Breakout');
      await create(test, 'setup', 'Pullback');
      expect(
        (await send(test, `/api/tags/${breakout}`, json('PATCH', { name: 'Range breakout' }))).status,
      ).toBe(200);
      const replies = [
        await send(test, `/api/tags/${breakout}`, json('PATCH', { name: 'pullback' })),
        await send(test, '/api/tags/nope', json('PATCH', { name: 'X' })),
      ];
      expect(await Promise.all(replies.map(async (r) => [r.status, await r.json()]))).toEqual([
        [409, { error: 'conflict' }],
        [404, { error: 'not_found' }],
      ]);
      // A case-only change of its own name is allowed.
      expect(
        (await send(test, `/api/tags/${breakout}`, json('PATCH', { name: 'RANGE breakout' }))).status,
      ).toBe(200);
      expect(db.prepare('SELECT name FROM tag WHERE id = ?').pluck().get(breakout)).toBe('RANGE breakout');
    });
  });

  it('deletes a tag: entries keep everything but the link, and the reply says how many lost it', async () => {
    await withVault(async ({ db }) => {
      const test = testApp({}, db);
      const breakout = await create(test, 'setup', 'Breakout');
      const early = await create(test, 'mistake', 'Entered early');
      entry(db, 'j1', breakout, [early]);
      entry(db, 'j2', null, [early]);
      const response = await send(test, `/api/tags/${early}`, { method: 'DELETE' });
      expect([response.status, await response.json()]).toEqual([200, { detached: 2 }]);
      expect(await list(test)).toEqual([{ id: breakout, kind: 'setup', name: 'Breakout', uses: 1 }]);
      expect(db.prepare('SELECT count(*) FROM journal_entry').pluck().get()).toBe(2n);
      const missing = await send(test, `/api/tags/${early}`, { method: 'DELETE' });
      expect([missing.status, await missing.json()]).toEqual([404, { error: 'not_found' }]);
    });
  });

  it('merges a tag into another of the same kind, without duplicating links', async () => {
    await withVault(async ({ db }) => {
      const test = testApp({}, db);
      const breakout = await create(test, 'setup', 'Breakout');
      const bo = await create(test, 'setup', 'BO');
      const early = await create(test, 'mistake', 'Entered early');
      const fomo = await create(test, 'mistake', 'FOMO');
      entry(db, 'j1', bo, [early, fomo]);
      entry(db, 'j2', breakout, [fomo]);
      entry(db, 'j3', null, [early]);

      const setups = await send(test, `/api/tags/${bo}/merge`, json('POST', { intoId: breakout }));
      expect([setups.status, await setups.json()]).toEqual([200, { merged: 1 }]);
      const mistakes = await send(test, `/api/tags/${fomo}/merge`, json('POST', { intoId: early }));
      expect([mistakes.status, await mistakes.json()]).toEqual([200, { merged: 2 }]);

      expect(await list(test)).toEqual([
        { id: breakout, kind: 'setup', name: 'Breakout', uses: 2 },
        { id: early, kind: 'mistake', name: 'Entered early', uses: 3 },
      ]);
      const links = db
        .prepare('SELECT journal_entry_id, tag_id FROM journal_tag ORDER BY journal_entry_id')
        .all();
      expect(links).toEqual([
        { journal_entry_id: 'j1', tag_id: early },
        { journal_entry_id: 'j2', tag_id: early },
        { journal_entry_id: 'j3', tag_id: early },
      ]);
    });
  });

  it('refuses a merge across kinds, into itself, or with an unknown tag', async () => {
    await withVault(async ({ db }) => {
      const test = testApp({}, db);
      const breakout = await create(test, 'setup', 'Breakout');
      const early = await create(test, 'mistake', 'Entered early');
      const replies = [
        await send(test, `/api/tags/${breakout}/merge`, json('POST', { intoId: early })),
        await send(test, `/api/tags/${breakout}/merge`, json('POST', { intoId: breakout })),
        await send(test, `/api/tags/${breakout}/merge`, json('POST', { intoId: 'nope' })),
        await send(test, '/api/tags/nope/merge', json('POST', { intoId: breakout })),
      ];
      expect(await Promise.all(replies.map(async (r) => [r.status, await r.json()]))).toEqual([
        [400, { error: 'invalid' }],
        [400, { error: 'invalid' }],
        [404, { error: 'not_found' }],
        [404, { error: 'not_found' }],
      ]);
      expect(await list(test)).toHaveLength(2);
    });
  });

  it('backs case-insensitive uniqueness with an index, for two processes racing', async () => {
    await withVault(({ db }) => {
      db.prepare("INSERT INTO tag (id, kind, name) VALUES ('t1', 'setup', 'Breakout')").run();
      expect(() =>
        db.prepare("INSERT INTO tag (id, kind, name) VALUES ('t2', 'setup', 'BREAKOUT')").run(),
      ).toThrow(/UNIQUE/);
    });
  });
});
