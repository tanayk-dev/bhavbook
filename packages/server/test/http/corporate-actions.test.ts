// S14b-1: corporate actions over HTTP (preview, apply, list, revert, restore) and the diagnostics export, whose
// privacy test imports the real fixtures and checks that none of their values, names or hashes appear in it.
import { describe, expect, it } from 'vitest';
import { recompute } from '../../src/recompute/index.js';
import { skipReasonSchema } from '@bhavbook/adapters';
import { csvCells, cellType, SKIP_REASONS } from '../../src/services/diagnostics.js';
import { DHAN, fixtureFile, importFiles, withVault, ZERODHA } from '../import/helpers.js';
import { send, testApp, type TestApp } from './helpers.js';

const HEADER =
  'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';
const TCS = 'INE467B01029';
const BUY = `TCS,${TCS},2025-09-12,NSE,EQ,EQ,buy,false,10,100,1,10,2025-09-12T10:00:00`;
const SPLIT = { type: 'SPLIT', isin: TCS, exDateIst: '2025-09-15', ratioNum: '5', ratioDen: '1' };

const json = (method: string, value: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

async function openQty(test: TestApp): Promise<string | undefined> {
  const body = (await (await send(test, '/api/positions?state=OPEN')).json()) as {
    positions: { openQty: string }[];
  };
  return body.positions[0]?.openQty;
}

describe('corporate actions', () => {
  it('previews a split, applies it, lists it, reverts and restores it', async () => {
    await withVault(async (vault) => {
      await importFiles(vault.service, ZERODHA, [{ bytes: Buffer.from(`${HEADER}\r\n${BUY}`) }]);
      recompute(vault.db, ZERODHA);
      const test = testApp({}, vault.db);

      const preview = await send(test, '/api/corporate-actions/preview', json('POST', SPLIT));
      expect(preview.status).toBe(200);
      const body = (await preview.json()) as {
        before: { quantity: string; costMicro: string; accountId: string }[];
        after: { quantity: string; costMicro: string }[];
        instruments: Record<string, string>;
        accounts: Record<string, { nickname: string; profileId: string }>;
      };
      expect(body.before).toEqual([expect.objectContaining({ quantity: '10', costMicro: '1000000000' })]);
      expect(body.after).toEqual([expect.objectContaining({ quantity: '50', costMicro: '1000000000' })]);
      expect(body.instruments[TCS]).toBe('TCS');
      expect(body.accounts[ZERODHA]).toEqual({ nickname: 'Z main', profileId: 'prof1' });
      expect(await openQty(test)).toBe('10');

      const applied = await send(test, '/api/corporate-actions', json('POST', SPLIT));
      expect(applied.status).toBe(201);
      const { id } = (await applied.json()) as { id: string };
      expect(await openQty(test)).toBe('50');
      // A double submit stores nothing new.
      expect(await (await send(test, '/api/corporate-actions', json('POST', SPLIT))).json()).toEqual({ id });

      const listed = (await (await send(test, '/api/corporate-actions')).json()) as {
        actions: { id: string; type: string; status: string; ratioNum: string }[];
        instruments: Record<string, string>;
      };
      expect(listed.actions).toEqual([
        expect.objectContaining({ id, type: 'SPLIT', status: 'active', ratioNum: '5' }),
      ]);
      expect(listed.instruments[TCS]).toBe('TCS');

      expect((await send(test, `/api/corporate-actions/${id}/revert`, { method: 'POST' })).status).toBe(200);
      expect(await openQty(test)).toBe('10');
      expect((await send(test, `/api/corporate-actions/${id}/revert`, { method: 'POST' })).status).toBe(404);
      expect((await send(test, `/api/corporate-actions/${id}/restore`, { method: 'POST' })).status).toBe(200);
      expect(await openQty(test)).toBe('50');
    });
  });

  it('refuses invalid actions and unknown ids with fixed codes', async () => {
    await withVault(async (vault) => {
      const test = testApp({}, vault.db);
      for (const bad of [
        { ...SPLIT, type: 'DEMERGER' }, // no child ISIN or cost split
        { ...SPLIT, ratioNum: '0' },
        { ...SPLIT, isin: 'nope' },
        { ...SPLIT, extra: true },
      ]) {
        const response = await send(test, '/api/corporate-actions/preview', json('POST', bad));
        expect(response.status).toBe(400);
        expect((await send(test, '/api/corporate-actions', json('POST', bad))).status).toBe(400);
      }
      expect((await send(test, '/api/corporate-actions/ca_nope/restore', { method: 'POST' })).status).toBe(
        404,
      );
      const restoredTwice = await send(test, '/api/corporate-actions', json('POST', SPLIT));
      const { id } = (await restoredTwice.json()) as { id: string };
      expect((await send(test, `/api/corporate-actions/${id}/revert`, { method: 'POST' })).status).toBe(200);
      // The same facts again while the first is reverted, then restoring the first: an identical one is active.
      expect((await send(test, '/api/corporate-actions', json('POST', SPLIT))).status).toBe(201);
      const conflict = await send(test, `/api/corporate-actions/${id}/restore`, { method: 'POST' });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ error: 'conflict' });
    });
  });
});

describe('an unreadable stored action', () => {
  it('is listed by id, blocks new actions with a 409, and can be reverted', async () => {
    await withVault(async (vault) => {
      // A split with a new ISIN: the schema allows it, core does not (only conversions and demergers have one).
      vault.db
        .prepare(
          `INSERT INTO corporate_action (id, type, isin, new_isin, ex_date, ratio_num, ratio_den, status, created_at)
           VALUES ('ca_bad', 'SPLIT', ?, 'INE000A01020', '2025-09-15', 5, 1, 'active', '2026-10-22T00:00:00Z')`,
        )
        .run(TCS);
      const test = testApp({}, vault.db);
      const listed = (await (await send(test, '/api/corporate-actions')).json()) as { actions: unknown[] };
      expect(listed.actions).toEqual([
        { id: 'ca_bad', unreadable: true, status: 'active', createdAt: '2026-10-22T00:00:00Z' },
      ]);
      const blocked = await send(test, '/api/corporate-actions/preview', json('POST', SPLIT));
      expect(blocked.status).toBe(409);
      expect((await send(test, '/api/corporate-actions/ca_bad/revert', { method: 'POST' })).status).toBe(200);
      expect((await send(test, '/api/corporate-actions/preview', json('POST', SPLIT))).status).toBe(200);
    });
  });
});

describe('the diagnostics export', () => {
  it('keeps exactly the skip reasons the adapters report', () => {
    expect([...SKIP_REASONS].sort()).toEqual([...skipReasonSchema.options].sort());
  });

  it('reads cell types and CSV cells without keeping values', () => {
    expect(
      ['', '42', '-1.5', '2024-09-17', '17-09-2024', '09:22:16', '2024-09-17T09:22:16', 'TRUE', 'Bajaj'].map(
        cellType,
      ),
    ).toEqual(['empty', 'integer', 'decimal', 'date', 'date', 'time', 'datetime', 'boolean', 'text']);
    expect(csvCells('a,"b, c","d ""e""",')).toEqual(['a', 'b, c', 'd "e"', '']);
  });

  it('holds counts, versions and shapes of the real fixtures, and none of their values, names or hashes', async () => {
    await withVault(async (vault) => {
      await importFiles(vault.service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      await importFiles(vault.service, DHAN, [
        fixtureFile('dhan', 'trade_history'),
        fixtureFile('dhan', 'tax_report'),
        fixtureFile('dhan', 'global_transactions'),
      ]);
      recompute(vault.db, ZERODHA);
      recompute(vault.db, DHAN);
      const test = testApp({}, vault.db);
      const response = await send(test, '/api/diagnostics');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain('bhavbook-diagnostics.json');
      const text = await response.text();
      const body = JSON.parse(text) as {
        format: string;
        app: { schemaVersion: number };
        batches: {
          broker: string;
          reportKind: string;
          tradeRows: number;
          tradeShapes: { shape: string }[];
        }[];
        accounts: { broker: string; batches: number }[];
      };
      expect(body.format).toBe('bhavbook-diagnostics/1');
      expect(body.app.schemaVersion).toBeGreaterThan(0);
      expect(body.accounts).toEqual([
        { broker: 'dhan', batches: 3 },
        { broker: 'zerodha', batches: 1 },
      ]);
      const trades = body.batches.find((batch) => batch.reportKind.startsWith('dhan') && batch.tradeRows > 0);
      expect(trades?.tradeShapes[0]?.shape).toMatch(
        /^(empty|integer|decimal|date|time|datetime|boolean|text)(,|$)/,
      );

      // Every value BhavBook stored from the files: none may appear in the export.
      const values = new Set<string>();
      for (const line of vault.db.prepare('SELECT raw_text FROM raw_row').pluck().all() as string[]) {
        for (const cell of csvCells(line)) values.add(cell.trim());
      }
      // Values and key names alike: a value used as a key must not leak either.
      const collect = (value: unknown): void => {
        if (typeof value === 'string') values.add(value.trim());
        else if (typeof value === 'object' && value !== null) {
          for (const [key, item] of Object.entries(value)) {
            values.add(key);
            collect(item);
          }
        }
      };
      for (const row of vault.db.prepare('SELECT key_json, data_json FROM statement_row').all() as {
        key_json: string;
        data_json: string;
      }[]) {
        collect(JSON.parse(row.key_json));
        collect(JSON.parse(row.data_json));
      }
      for (const name of vault.db.prepare('SELECT display_name FROM instrument').pluck().all() as string[])
        values.add(name);
      // A batch's counts: anything beyond the known structure and skip reasons must not reach the export.
      const known = new Set(['rows', 'statements', 'skipped', 'errors', 'new', 'duplicate', ...SKIP_REASONS]);
      const unknownKeys = (value: unknown): void => {
        if (typeof value !== 'object' || value === null) return;
        for (const [key, item] of Object.entries(value)) {
          if (!known.has(key)) values.add(key);
          unknownKeys(item);
        }
      };
      for (const counts of vault.db
        .prepare('SELECT counts_json FROM import_batch')
        .pluck()
        .all() as string[]) {
        unknownKeys(JSON.parse(counts));
      }
      for (const hash of vault.db.prepare('SELECT file_sha256 FROM import_batch').pluck().all() as string[])
        values.add(hash);
      // The names the files were imported under.
      for (const name of ['tradebook.csv', 'trade_history.csv', 'tax_report.csv', 'global_transactions.csv'])
        values.add(name);
      // Short or purely numeric tokens (a count, "NSE") say nothing about the user; everything else must be absent.
      const telling = [...values].filter((value) => value.length >= 5 && !/^\d{1,6}$/.test(value));
      expect(telling.length).toBeGreaterThan(50);
      // Field names adapters chose (`buy_qty`) are the shapes themselves: only data may not appear.
      const fields = new Set(text.match(/[a-z][a-z0-9_]{4,40}(?=:)/g) ?? []);
      expect(telling.filter((value) => text.includes(value) && !fields.has(value))).toEqual([]);
      // Counts are rebuilt from known keys only.
      for (const batch of (JSON.parse(text) as { batches: { counts: Record<string, unknown> }[] }).batches) {
        expect(Object.keys(batch.counts).sort()).toEqual(['errors', 'rows', 'skipped', 'statements']);
      }
    });
  });
});
