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

describe('S13a-2 review: labels and requests', () => {
  const code = (run: () => unknown): string => {
    try {
      run();
      return 'ok';
    } catch (error) {
      return error instanceof ProfileError ? error.code : 'other';
    }
  };

  it.each([
    ['a PAN', 'ABCDE1234F'],
    ['a PAN with spaces', 'abcde 1234 f'],
    ['a Zerodha-style client ID', 'ZM1234'],
    ['a numeric client ID', '1100123456'],
  ])('refuses a label shaped like %s', async (_, nickname) => {
    await withFreshVault((db) => {
      const profile = createProfile(db, { name: 'Swing' });
      expect(code(() => createAccount(db, { profileId: profile, broker: 'dhan', nickname }))).toBe(
        'identifier',
      );
      expect(code(() => createProfile(db, { name: nickname }))).toBe('identifier');
    });
  });

  it.each([
    ['a line separator', 'a\u2028b'],
    ['a paragraph separator', 'a\u2029b'],
    ['a no-break space', 'a\u00a0b'],
    ['a blank-looking filler only', '\u3164\u3164'],
    ['braille blanks only', '\u2800'],
    ['punctuation only', '---'],
    ['a private-use character', 'a\ue000'],
    ['a lone surrogate', 'a\ud800b'],
  ])('refuses a label with %s', async (_, name) => {
    await withFreshVault((db) => {
      expect(code(() => createProfile(db, { name }))).toBe('invalid');
    });
  });

  it('keeps ordinary labels, NFC-normalised, and folds case beyond ASCII', async () => {
    await withFreshVault((db) => {
      createProfile(db, { name: 'Cafe\u0301 swing' });
      expect(listProfiles(db).map((profile) => profile.name)).toEqual(['Caf\u00e9 swing']);
      expect(code(() => createProfile(db, { name: 'CAF\u00c9 SWING' }))).toBe('conflict');
      expect(code(() => createProfile(db, { name: 'Long-term 2024' }))).toBe('ok');
    });
  });

  it('the database itself refuses a duplicate (ASCII case-insensitive)', async () => {
    await withFreshVault((db) => {
      const profile = createProfile(db, { name: 'Swing' });
      createAccount(db, { profileId: profile, broker: 'dhan', nickname: 'Main' });
      const entity = db.prepare('SELECT pan_entity_id FROM profile').pluck().get();
      expect(() =>
        db
          .prepare("INSERT INTO profile (id, pan_entity_id, name, created_at) VALUES ('x', ?, 'SWING', 'x')")
          .run(entity),
      ).toThrow(/UNIQUE/);
      expect(() =>
        db
          .prepare(
            "INSERT INTO broker_account (id, profile_id, broker, nickname, created_at) VALUES ('y', ?, 'dhan', 'MAIN', 'x')",
          )
          .run(profile),
      ).toThrow(/UNIQUE/);
    });
  });

  it('mutating routes refuse a missing Origin, a cross-site fetch, the wrong content type and big bodies', async () => {
    await withFreshVault(async (db) => {
      const test = testApp({}, db);
      const json = { 'content-type': 'application/json' };
      const statuses = [
        (await send(test, '/api/profiles', { ...post({ name: 'A' }), headers: { ...json, origin: null } }))
          .status,
        (
          await send(test, '/api/profiles', {
            ...post({ name: 'A' }),
            headers: { ...json, 'sec-fetch-site': 'cross-site' },
          })
        ).status,
        (
          await send(test, '/api/profiles', {
            ...post({ name: 'A' }),
            headers: { 'content-type': 'text/plain' },
          })
        ).status,
        (await send(test, '/api/profiles', post({ name: 'x'.repeat(5000) }))).status,
      ];
      expect(statuses).toEqual([403, 403, 415, 413]);
      expect(db.prepare('SELECT count(*) FROM profile').pluck().get()).toBe(0n);
    });
  });

  it('never logs a label', async () => {
    await withFreshVault(async (db) => {
      const test = testApp({}, db);
      await send(test, '/api/profiles', post({ name: 'MARKER profile' }));
      await send(test, '/api/profiles', post({ name: 'MARKER profile' }));
      expect(test.lines.join('\n')).not.toContain('MARKER');
    });
  });
});
