// S13a-3a: settings API. Rename profiles and accounts; move an account to another profile, which recomputes it in
// the same transaction (PRD §2 C5); the breakeven threshold; the fee-rule versions behind the stored charges.
import { describe, expect, it } from 'vitest';
import { recompute } from '../../src/recompute/index.js';
import { DHAN, fixtureFile, importFiles, withVault, ZERODHA } from '../import/helpers.js';
import { send, testApp } from './helpers.js';

const now = (): Date => new Date('2026-10-20T12:00:00Z');
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('rename', () => {
  it('renames a profile and an account, with the same rules as creating them', async () => {
    await withVault(async ({ db }) => {
      const test = testApp({}, db);
      db.prepare(
        "INSERT INTO profile (id, pan_entity_id, name, created_at) VALUES ('prof2', 'pan1', 'Long-term', 'x')",
      ).run();
      expect((await send(test, '/api/profiles/prof1', json('PATCH', { name: 'Swing trades' }))).status).toBe(
        200,
      );
      expect((await send(test, `/api/accounts/${ZERODHA}`, json('PATCH', { nickname: 'Kite' }))).status).toBe(
        200,
      );
      expect(db.prepare("SELECT name FROM profile WHERE id = 'prof1'").pluck().get()).toBe('Swing trades');
      expect(db.prepare('SELECT nickname FROM broker_account WHERE id = ?').pluck().get(ZERODHA)).toBe(
        'Kite',
      );

      const codes = [
        await send(test, '/api/profiles/prof1', json('PATCH', { name: 'long-term' })),
        await send(test, `/api/accounts/${DHAN}`, json('PATCH', { nickname: 'kite' })),
        await send(test, '/api/profiles/nope', json('PATCH', { name: 'X' })),
        await send(test, `/api/accounts/${DHAN}`, json('PATCH', { nickname: 'ABCDE1234F' })),
      ];
      expect(
        await Promise.all(codes.map(async (response) => [response.status, await response.json()])),
      ).toEqual([
        [409, { error: 'conflict' }],
        [409, { error: 'conflict' }],
        [404, { error: 'not_found' }],
        [400, { error: 'identifier' }],
      ]);
    });
  });
});

describe('move an account to another profile', () => {
  it('moves it and recomputes it in one step', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, DHAN, [fixtureFile('dhan', 'trade_history')]);
      const before = recompute(db, DHAN, { now });
      db.prepare(
        "INSERT INTO profile (id, pan_entity_id, name, created_at) VALUES ('prof2', 'pan1', 'Long-term', 'x')",
      ).run();
      db.prepare('DELETE FROM position WHERE account_id = ?').run(DHAN);
      const response = await send(
        testApp({}, db),
        `/api/accounts/${DHAN}/move`,
        json('POST', { profileId: 'prof2' }),
      );
      expect([response.status, await response.json()]).toEqual([200, { recomputed: before.positions }]);
      expect(db.prepare('SELECT profile_id FROM broker_account WHERE id = ?').pluck().get(DHAN)).toBe(
        'prof2',
      );
      expect(db.prepare('SELECT count(*) FROM position WHERE account_id = ?').pluck().get(DHAN)).toBe(
        BigInt(before.positions),
      );
    });
  });

  it('refuses a nickname clash in the target profile, and an unknown profile', async () => {
    await withVault(async ({ db }) => {
      db.prepare(
        "INSERT INTO profile (id, pan_entity_id, name, created_at) VALUES ('prof2', 'pan1', 'Long-term', 'x')",
      ).run();
      db.prepare(
        "INSERT INTO broker_account (id, profile_id, broker, nickname, created_at) VALUES ('acc3', 'prof2', 'dhan', 'd MAIN', 'x')",
      ).run();
      const test = testApp({}, db);
      const clash = await send(test, `/api/accounts/${DHAN}/move`, json('POST', { profileId: 'prof2' }));
      const missing = await send(test, `/api/accounts/${DHAN}/move`, json('POST', { profileId: 'nope' }));
      expect([clash.status, missing.status]).toEqual([409, 404]);
      expect(db.prepare('SELECT profile_id FROM broker_account WHERE id = ?').pluck().get(DHAN)).toBe(
        'prof1',
      );
    });
  });

  it('when the recompute fails, nothing moves', async () => {
    await withVault(async ({ db }) => {
      db.prepare(
        "INSERT INTO profile (id, pan_entity_id, name, created_at) VALUES ('prof2', 'pan1', 'Long-term', 'x')",
      ).run();
      db.prepare(
        "INSERT INTO adjustment (id, account_id, type, payload_json, source, status, created_at) VALUES ('bad', ?, 'exclude', '{broken', 'manual', 'active', 'x')",
      ).run(DHAN);
      const response = await send(
        testApp({}, db),
        `/api/accounts/${DHAN}/move`,
        json('POST', { profileId: 'prof2' }),
      );
      expect([response.status, await response.json()]).toEqual([500, { error: 'internal_error' }]);
      expect(db.prepare('SELECT profile_id FROM broker_account WHERE id = ?').pluck().get(DHAN)).toBe(
        'prof1',
      );
    });
  });
});

describe('settings', () => {
  it('breakeven defaults to Rs 0, accepts rupees to the paisa, and refuses anything else', async () => {
    await withVault(async ({ db }) => {
      const test = testApp({}, db);
      const read = async () =>
        ((await (await send(test, '/api/settings')).json()) as { breakevenThresholdMicro: string })
          .breakevenThresholdMicro;
      expect(await read()).toBe('0');
      expect(
        (await send(test, '/api/settings', json('PUT', { breakevenThresholdRupees: '12.50' }))).status,
      ).toBe(200);
      expect(await read()).toBe('12500000');
      const statuses = await Promise.all(
        ['-1', '1.234', '12,50', 'abc', '99999999'].map(
          async (value) =>
            (await send(test, '/api/settings', json('PUT', { breakevenThresholdRupees: value }))).status,
        ),
      );
      expect(statuses).toEqual([400, 400, 400, 400, 400]);
      expect(await read()).toBe('12500000');
    });
  });

  it('lists every bundled fee-rule version with the charges that use it', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      recompute(db, ZERODHA, { now });
      const { feeRules } = (await (await send(testApp({}, db), '/api/settings')).json()) as {
        feeRules: { id: string; kind: string; charges: number }[];
      };
      expect(feeRules.map((rule) => rule.id)).toContain('nse/2024-10-01');
      expect(feeRules.find((rule) => rule.id === 'zerodha/2024-06-01')?.charges).toBeGreaterThan(0);
      expect(feeRules.find((rule) => rule.id === 'dhan/2024-04-01')?.charges).toBe(0);
    });
  });
});
