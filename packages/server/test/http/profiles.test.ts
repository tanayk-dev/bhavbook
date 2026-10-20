// S13a-2: onboarding's API. Profiles in a default PAN entity (a label, never a PAN), broker accounts with a broker
// and a nickname only (no client ID, PRD §4), validated labels, and fixed error codes (ADR-0019).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createAccount, createProfile, listProfiles, ProfileError } from '../../src/services/profiles.js';
import { openVault } from '../../src/vault/index.js';
import { send, testApp } from './helpers.js';

async function withFreshVault(run: (db: Database.Database) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bhavbook-profiles-'));
  const db = openVault(path.join(dir, 'vault.db'), { appVersion: 'test' });
  try {
    await run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('profiles and accounts (service)', () => {
  it('creates a default PAN entity once, then profiles and accounts in order', async () => {
    await withFreshVault((db) => {
      const swing = createProfile(db, { name: '  Swing  ' });
      const positional = createProfile(db, { name: 'Positional' });
      const zerodha = createAccount(db, { profileId: swing, broker: 'zerodha', nickname: 'Z main' });
      createAccount(db, { profileId: swing, broker: 'dhan', nickname: 'D main' });
      expect(db.prepare('SELECT label FROM pan_entity').pluck().all()).toEqual(['Default']);
      expect(listProfiles(db)).toEqual([
        {
          id: swing,
          name: 'Swing',
          accounts: [
            { id: zerodha, broker: 'zerodha', nickname: 'Z main' },
            { id: expect.stringMatching(/^acc_/) as unknown, broker: 'dhan', nickname: 'D main' },
          ],
        },
        { id: positional, name: 'Positional', accounts: [] },
      ]);
    });
  });

  it.each([
    ['an empty name', { name: '   ' }],
    ['a name over 40 characters', { name: 'x'.repeat(41) }],
    ['a line break', { name: 'a\nb' }],
    ['a zero-width character', { name: 'a​b' }],
    ['an unknown field (no client IDs, ever)', { name: 'Swing', clientId: 'AB1234' }],
  ])('rejects a profile with %s', async (_, input) => {
    await withFreshVault((db) => {
      expect(() => createProfile(db, input)).toThrow(ProfileError);
      expect(db.prepare('SELECT count(*) FROM profile').pluck().get()).toBe(0n);
    });
  });

  it('refuses duplicate names (ignoring case), unknown profiles, unknown brokers and client IDs', async () => {
    await withFreshVault((db) => {
      const swing = createProfile(db, { name: 'Swing' });
      const code = (run: () => unknown) => {
        try {
          run();
          return 'ok';
        } catch (error) {
          return error instanceof ProfileError ? error.code : 'other';
        }
      };
      expect(code(() => createProfile(db, { name: 'SWING' }))).toBe('conflict');
      createAccount(db, { profileId: swing, broker: 'zerodha', nickname: 'Main' });
      expect(code(() => createAccount(db, { profileId: swing, broker: 'dhan', nickname: 'main' }))).toBe(
        'conflict',
      );
      expect(code(() => createAccount(db, { profileId: 'nope', broker: 'dhan', nickname: 'X' }))).toBe(
        'not_found',
      );
      expect(code(() => createAccount(db, { profileId: swing, broker: 'upstox', nickname: 'X' }))).toBe(
        'invalid',
      );
      expect(
        code(() => createAccount(db, { profileId: swing, broker: 'dhan', nickname: 'X', clientId: '1100' })),
      ).toBe('invalid');
    });
  });
});

describe('profiles and accounts (HTTP)', () => {
  it('lists, creates and returns fixed error codes', async () => {
    await withFreshVault(async (db) => {
      const test = testApp({}, db);
      expect(await (await send(test, '/api/profiles')).json()).toEqual({ profiles: [] });
      const created = await send(test, '/api/profiles', post({ name: 'Swing' }));
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      const account = await send(
        test,
        '/api/accounts',
        post({ profileId: id, broker: 'dhan', nickname: 'D main' }),
      );
      expect(account.status).toBe(201);
      const listed = (await (await send(test, '/api/profiles')).json()) as {
        profiles: { accounts: unknown[] }[];
      };
      expect(listed.profiles[0]?.accounts).toHaveLength(1);

      const duplicate = await send(test, '/api/profiles', post({ name: 'swing' }));
      expect([duplicate.status, await duplicate.json()]).toEqual([409, { error: 'conflict' }]);
      const missing = await send(
        test,
        '/api/accounts',
        post({ profileId: 'nope', broker: 'dhan', nickname: 'X' }),
      );
      expect([missing.status, await missing.json()]).toEqual([404, { error: 'not_found' }]);
      const invalid = await send(test, '/api/profiles', post({ name: 'MARKER\n' + 'x'.repeat(50) }));
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).not.toContain('MARKER');
    });
  });

  it('needs a vault and the session', async () => {
    expect((await send(testApp({}, null), '/api/profiles')).status).toBe(503);
    await withFreshVault(async (db) => {
      const test = testApp({}, db);
      expect((await send(test, '/api/profiles', { headers: { cookie: null } })).status).toBe(401);
      const crossSite = await send(test, '/api/profiles', {
        ...post({ name: 'X' }),
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      });
      expect(crossSite.status).toBe(403);
      expect(db.prepare('SELECT count(*) FROM profile').pluck().get()).toBe(0n);
    });
  });
});
