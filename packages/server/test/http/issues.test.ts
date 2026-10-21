// S13c-1: the issues inbox API. List and filter issues with readable instrument names, the open summary, dismiss
// and reopen, and each kind's fix: accept a statement lot, add an opening lot or exclude a position (and revert it),
// map an unresolved instrument (with suggestions). Every fix recomputes, so the issue resolves itself.
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { recompute } from '../../src/recompute/index.js';
import {
  DHAN,
  fixtureBytes,
  fixtureFile,
  importFiles,
  withVault,
  type TestVault,
} from '../import/helpers.js';
import { send, testApp, type TestApp } from './helpers.js';

const BAJAJ = 'INE377Y01014';

const json = (method: string, value: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

interface Issue {
  id: string;
  kind: string;
  status: string;
  accountId: string | null;
  accountNickname: string | null;
  broker: string | null;
  subject: Record<string, unknown>;
}

async function issues(
  test: TestApp,
  filter = '',
): Promise<{ issues: Issue[]; instruments: Record<string, string> }> {
  const response = await send(test, `/api/issues${filter}`);
  expect(response.status).toBe(200);
  return (await response.json()) as { issues: Issue[]; instruments: Record<string, string> };
}

async function only(test: TestApp, kind: string): Promise<Issue> {
  const [issue, ...rest] = (await issues(test, `?kind=${kind}`)).issues;
  if (issue === undefined || rest.length > 0) throw new Error(`expected one open ${kind} issue`);
  return issue;
}

/** Dhan FY 2024-25 without the 17 Sep IPO allotment: an orphan sell the Tax Report can fill (plan E11). */
async function withoutAllotment({ db, service }: TestVault): Promise<void> {
  const trades = fixtureBytes('dhan', 'trade_history')
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('2024-09-17,09:22:16,Bajaj Housing Finance'))
    .join('\r\n');
  await importFiles(service, DHAN, [
    { bytes: Buffer.from(trades) },
    fixtureFile('dhan', 'global_transactions'),
    fixtureFile('dhan', 'dp_charges'),
    fixtureFile('dhan', 'tax_report', 'tax.xls'),
  ]);
  recompute(db, DHAN);
}

const status = (db: Database.Database, id: string): unknown =>
  db.prepare('SELECT status FROM issue WHERE id = ?').pluck().get(id);

describe('the inbox', () => {
  it('lists open issues with their account and readable instrument names, filters, and summarises', async () => {
    await withVault(async (vault) => {
      await withoutAllotment(vault);
      const test = testApp({}, vault.db);
      const all = await issues(test);
      const fill = all.issues.find((issue) => issue.kind === 'fill_from_statement');
      expect(fill).toMatchObject({
        status: 'open',
        accountId: DHAN,
        accountNickname: 'D main',
        broker: 'dhan',
      });
      expect(fill?.subject).toMatchObject({ instrumentKey: BAJAJ, quantity: '200' });
      expect(all.instruments[BAJAJ]).toMatch(/Bajaj Housing/);

      const summary = (await (await send(test, '/api/issues/summary')).json()) as {
        open: number;
        byKind: Record<string, number>;
      };
      expect(summary.open).toBe(all.issues.length);
      expect(summary.byKind.fill_from_statement).toBe(1);
      expect((await issues(test, '?kind=fill_from_statement')).issues).toHaveLength(1);
      expect((await issues(test, `?accountId=${DHAN}&kind=fill_from_statement`)).issues).toHaveLength(1);
      expect((await issues(test, '?accountId=nope')).issues).toEqual([]);
      expect((await send(test, '/api/issues?status=bogus')).status).toBe(400);
    });
  });

  it('dismisses and reopens an issue', async () => {
    await withVault(async (vault) => {
      await withoutAllotment(vault);
      const test = testApp({}, vault.db);
      const issue = await only(test, 'fill_from_statement');
      expect((await send(test, `/api/issues/${issue.id}/dismiss`, { method: 'POST' })).status).toBe(200);
      expect((await issues(test, '?kind=fill_from_statement')).issues).toEqual([]);
      expect((await issues(test, '?status=dismissed&kind=fill_from_statement')).issues).toHaveLength(1);
      // A recompute never re-opens a dismissal.
      recompute(vault.db, DHAN);
      expect(status(vault.db, issue.id)).toBe('dismissed');
      const again = await send(test, `/api/issues/${issue.id}/dismiss`, { method: 'POST' });
      expect([again.status, await again.json()]).toEqual([404, { error: 'not_found' }]);
      expect((await send(test, `/api/issues/${issue.id}/reopen`, { method: 'POST' })).status).toBe(200);
      expect(status(vault.db, issue.id)).toBe('open');
    });
  });

  it('accepting the statement lot completes the position and resolves both issues', async () => {
    await withVault(async (vault) => {
      await withoutAllotment(vault);
      const test = testApp({}, vault.db);
      const fill = await only(test, 'fill_from_statement');
      const response = await send(test, `/api/issues/${fill.id}/accept`, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ adjustmentId: expect.any(String) as string });
      expect(status(vault.db, fill.id)).toBe('resolved');
      expect((await issues(test, '?kind=incomplete_position')).issues).toEqual([]);
    });
  });

  it('an opening lot or an exclusion fixes an incomplete position; reverting the lot brings it back', async () => {
    await withVault(async (vault) => {
      await withoutAllotment(vault);
      const test = testApp({}, vault.db);
      const incomplete = await only(test, 'incomplete_position');
      const created = await send(
        test,
        `/api/accounts/${DHAN}/adjustments`,
        json('POST', {
          kind: 'opening_lot',
          instrumentKey: BAJAJ,
          bucket: 'DELIVERY',
          quantity: '200',
          totalCostMicro: '35200000000',
          entryDateIst: '2024-09-17',
        }),
      );
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      expect(status(vault.db, incomplete.id)).toBe('resolved');

      expect((await send(test, `/api/adjustments/${id}/revert`, { method: 'POST' })).status).toBe(200);
      expect(status(vault.db, incomplete.id)).toBe('open');

      // Excluding the position instead: it stays incomplete but leaves every metric.
      const anchor = vault.db
        .prepare('SELECT fingerprint FROM issue WHERE id = ?')
        .pluck()
        .get(incomplete.id);
      const excluded = await send(
        test,
        `/api/accounts/${DHAN}/adjustments`,
        json('POST', { kind: 'exclude', anchorKey: anchor }),
      );
      expect(excluded.status).toBe(201);
      expect(vault.db.prepare('SELECT count(*) FROM position WHERE excluded = 1').pluck().get()).toBe(1n);
    });
  });

  it('maps an unresolved instrument, with suggestions, and recomputes the broker', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, DHAN, [fixtureFile('dhan', 'trade_history')]);
      recompute(db, DHAN);
      const test = testApp({}, db);
      const unresolved = (await issues(test, '?kind=unresolved_instrument')).issues;
      expect(unresolved.length).toBeGreaterThan(0);
      const [first] = unresolved;
      if (first === undefined) throw new Error('no unresolved instrument');
      const alias = first.subject.alias as string;
      const suggestions = await send(test, `/api/issues/${first.id}/suggestions`);
      expect(suggestions.status).toBe(200);
      expect(Array.isArray(((await suggestions.json()) as { suggestions: unknown }).suggestions)).toBe(true);

      const isin = 'INE000A01020';
      expect(
        (await send(test, `/api/issues/${first.id}/map`, json('POST', { isin, displayName: alias }))).status,
      ).toBe(200);
      expect(status(db, first.id)).toBe('resolved');
      expect(db.prepare('SELECT count(*) FROM position WHERE instrument_key = ?').pluck().get(isin)).not.toBe(
        0n,
      );
    });
  });

  it('answers fixed codes for what the person can fix', async () => {
    await withVault(async (vault) => {
      await withoutAllotment(vault);
      const test = testApp({}, vault.db);
      const statementIssue = await only(test, 'fill_from_statement');
      const replies = [
        await send(test, '/api/issues/nope/accept', { method: 'POST' }),
        await send(test, '/api/issues/nope/reopen', { method: 'POST' }),
        await send(test, `/api/issues/${statementIssue.id}/replace`, { method: 'POST' }),
        await send(test, `/api/issues/${statementIssue.id}/suggestions`),
        await send(
          test,
          `/api/accounts/${DHAN}/adjustments`,
          json('POST', { kind: 'opening_lot', quantity: 'x' }),
        ),
        await send(test, '/api/accounts/nope/adjustments', json('POST', { kind: 'exclude', anchorKey: 'a' })),
        await send(test, '/api/adjustments/nope/revert', { method: 'POST' }),
      ];
      expect(await Promise.all(replies.map(async (reply) => [reply.status, await reply.json()]))).toEqual([
        [404, { error: 'not_found' }],
        [404, { error: 'not_found' }],
        [404, { error: 'not_found' }],
        [404, { error: 'not_found' }],
        [400, { error: 'invalid' }],
        [404, { error: 'not_found' }],
        [404, { error: 'not_found' }],
      ]);
    });
  });
});
