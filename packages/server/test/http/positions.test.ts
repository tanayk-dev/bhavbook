// S14a-1: positions and the journal over HTTP. The review queue (closed, complete, not excluded, unreviewed; newest
// first) and its counter; the position detail (fills raw and normalised, lots, charges); journal saves (tags checked,
// the initial stop fixed once closed, collisions refused without a choice), review and reopen; a draft written on an
// open position survives the recompute that closes it.
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { recompute } from '../../src/recompute/index.js';
import { positionRef } from '../../src/services/positions.js';
import { importFiles, withVault, ZERODHA, type TestVault } from '../import/helpers.js';
import { send, testApp, type TestApp } from './helpers.js';

const HEADER =
  'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';
const BUY = 'TCS,INE467B01029,2025-09-12,NSE,EQ,EQ,buy,false,10,100,1,10,2025-09-12T10:00:00';
const SELL = 'TCS,INE467B01029,2025-09-15,NSE,EQ,EQ,sell,false,10,120,2,20,2025-09-15T11:00:00';
const INFY_BUY = 'INFY,INE009A01021,2025-09-16,NSE,EQ,EQ,buy,false,5,1500,3,30,2025-09-16T10:00:00';
const INFY_SELL = 'INFY,INE009A01021,2025-09-18,NSE,EQ,EQ,sell,false,5,1400,4,40,2025-09-18T10:00:00';

const json = (method: string, value: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

const tradebook = (...rows: string[]) => ({ bytes: Buffer.from([HEADER, ...rows].join('\r\n')) });

interface Summary {
  ref: string;
  state: string;
  instrumentKey: string;
  openQty: string;
  realisedGrossMicro: string;
  chargesMicro: string;
  reviewedAt: string | null;
  journalEntries: number;
}

async function list(test: TestApp, filter = ''): Promise<{ positions: Summary[]; total: number }> {
  const response = await send(test, `/api/positions${filter}`);
  expect(response.status).toBe(200);
  return (await response.json()) as { positions: Summary[]; total: number };
}

async function detail(test: TestApp, ref: string) {
  const response = await send(test, `/api/positions/${ref}`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    position: Summary;
    instruments: Record<string, string>;
    fills: {
      side: string;
      inferred: boolean;
      source: string;
      trade: { raw: string | null; productDeclared: null };
    }[];
    lots: { quantity: string; entryValueMicro: string; exitValueMicro: string | null }[];
    charges: { component: string; source: string; amountMicro: string }[];
    journal: {
      id: string;
      thesis: string | null;
      initialStopMicro: string | null;
      mistakeTagIds: string[];
    }[];
  };
}

const ENTRY = {
  setupTagId: null,
  mistakeTagIds: [],
  thesis: null,
  initialStopMicro: null,
  plannedStopMicro: null,
  plannedTargetMicro: null,
  plannedRiskMicro: null,
  reviewNote: null,
};

function tag(db: Database.Database, id: string, kind: string): void {
  db.prepare('INSERT INTO tag (id, kind, name) VALUES (?, ?, ?)').run(id, kind, id);
}

async function withPositions(rows: string[], run: (test: TestApp, vault: TestVault) => Promise<void>) {
  await withVault(async (vault) => {
    await importFiles(vault.service, ZERODHA, [tradebook(...rows)]);
    recompute(vault.db, ZERODHA);
    await run(testApp({}, vault.db), vault);
  });
}

describe('the review queue', () => {
  it('lists closed, unreviewed positions newest first, with their P&L and charges; review and reopen', async () => {
    await withPositions([BUY, SELL, INFY_BUY, INFY_SELL], async (test) => {
      const queue = await list(test, '?review=unreviewed');
      expect(queue.positions.map((position) => position.instrumentKey)).toEqual([
        'INE009A01021',
        'INE467B01029',
      ]);
      const [infy, tcs] = queue.positions;
      if (infy === undefined || tcs === undefined) throw new Error('positions missing');
      expect(tcs).toMatchObject({ state: 'CLOSED', openQty: '0', realisedGrossMicro: '200000000' });
      expect(infy.realisedGrossMicro).toBe('-500000000');
      expect(BigInt(tcs.chargesMicro)).toBeGreaterThan(0n);
      expect(await (await send(test, '/api/positions/review-count')).json()).toEqual({ count: 2 });

      expect((await send(test, `/api/positions/${tcs.ref}/review`, { method: 'POST' })).status).toBe(200);
      expect((await list(test, '?review=unreviewed')).positions.map((position) => position.ref)).toEqual([
        infy.ref,
      ]);
      expect((await list(test, '?review=reviewed')).positions[0]).toMatchObject({
        ref: tcs.ref,
        journalEntries: 1,
      });
      expect(await (await send(test, '/api/positions/review-count')).json()).toEqual({ count: 1 });

      expect((await send(test, `/api/positions/${tcs.ref}/reopen`, { method: 'POST' })).status).toBe(200);
      expect((await list(test, '?review=unreviewed')).total).toBe(2);
    });
  });

  it('filters by account and state, and refuses unknown filters', async () => {
    await withPositions([BUY, SELL, INFY_BUY], async (test) => {
      expect((await list(test, '?state=OPEN')).positions.map((position) => position.instrumentKey)).toEqual([
        'INE009A01021',
      ]);
      expect((await list(test, `?accountId=${ZERODHA}`)).total).toBe(2);
      expect((await list(test, '?accountId=acc_dhan')).total).toBe(0);
      expect((await send(test, '/api/positions?state=gone')).status).toBe(400);
      expect((await send(test, '/api/positions?sort=x')).status).toBe(400);
    });
  });
});

describe('the position detail', () => {
  it('shows fills raw and normalised, the inferred product, lots and estimated charges', async () => {
    await withPositions([BUY, SELL], async (test) => {
      const [position] = (await list(test)).positions;
      if (position === undefined) throw new Error('no position');
      const view = await detail(test, position.ref);
      expect(view.instruments).toEqual({ INE467B01029: 'TCS' });
      expect(view.fills.map((fill) => fill.side)).toEqual(['BUY', 'SELL']);
      expect(view.fills[0]).toMatchObject({
        source: 'trade',
        inferred: true,
        trade: { productDeclared: null },
      });
      expect(view.fills[0]?.trade.raw).toBe(BUY);
      expect(view.lots).toEqual([
        expect.objectContaining({
          quantity: '10',
          entryValueMicro: '1000000000',
          exitValueMicro: '1200000000',
        }),
      ]);
      expect(view.charges.some((charge) => charge.component === 'stt' && charge.source === 'estimated')).toBe(
        true,
      );
    });
  });

  it('answers 404 for a position that is not there and 400 for a malformed reference', async () => {
    await withPositions([BUY], async (test) => {
      expect((await send(test, `/api/positions/${positionRef('acc|nope|DELIVERY|x')}`)).status).toBe(404);
      expect((await send(test, '/api/positions/a%7Cb')).status).toBe(400);
    });
  });
});

describe('the journal', () => {
  it('drafts on an open position, and the draft survives the recompute that closes it', async () => {
    await withVault(async (vault) => {
      await importFiles(vault.service, ZERODHA, [tradebook(BUY)]);
      recompute(vault.db, ZERODHA);
      const test = testApp({}, vault.db);
      const [open] = (await list(test)).positions;
      if (open === undefined) throw new Error('no position');
      expect((await send(test, `/api/positions/${open.ref}/review`, { method: 'POST' })).status).toBe(400);
      const saved = await send(
        test,
        `/api/positions/${open.ref}/journal`,
        json('PUT', { ...ENTRY, thesis: '  Breakout above 95  ', initialStopMicro: '95000000' }),
      );
      expect(saved.status).toBe(200);

      await importFiles(vault.service, ZERODHA, [tradebook(SELL)]);
      recompute(vault.db, ZERODHA);
      const view = await detail(test, open.ref);
      expect(view.position.state).toBe('CLOSED');
      expect(view.journal).toEqual([
        expect.objectContaining({ thesis: 'Breakout above 95', initialStopMicro: '95000000' }),
      ]);
    });
  });

  it('fixes the initial stop once the position has closed; other fields stay editable', async () => {
    await withPositions([BUY, SELL], async (test) => {
      const [position] = (await list(test)).positions;
      if (position === undefined) throw new Error('no position');
      const path = `/api/positions/${position.ref}/journal`;
      const locked = await send(test, path, json('PUT', { ...ENTRY, initialStopMicro: '95000000' }));
      expect(locked.status).toBe(409);
      expect(await locked.json()).toEqual({ error: 'conflict' });
      expect((await send(test, path, json('PUT', { ...ENTRY, reviewNote: 'Sold too early' }))).status).toBe(
        200,
      );
      expect((await detail(test, position.ref)).journal).toHaveLength(1);
    });
  });

  it('checks tags by kind and keeps the mistake tags as sent', async () => {
    await withPositions([BUY, SELL], async (test, vault) => {
      tag(vault.db, 'tag_setup', 'setup');
      tag(vault.db, 'tag_fomo', 'mistake');
      tag(vault.db, 'tag_late', 'mistake');
      const [position] = (await list(test)).positions;
      if (position === undefined) throw new Error('no position');
      const path = `/api/positions/${position.ref}/journal`;
      expect((await send(test, path, json('PUT', { ...ENTRY, setupTagId: 'tag_fomo' }))).status).toBe(400);
      expect((await send(test, path, json('PUT', { ...ENTRY, mistakeTagIds: ['tag_nope'] }))).status).toBe(
        400,
      );
      const body = { ...ENTRY, setupTagId: 'tag_setup', mistakeTagIds: ['tag_late', 'tag_fomo'] };
      expect((await send(test, path, json('PUT', body))).status).toBe(200);
      expect((await send(test, path, json('PUT', { ...body, mistakeTagIds: ['tag_late'] }))).status).toBe(
        200,
      );
      expect((await detail(test, position.ref)).journal[0]?.mistakeTagIds).toEqual(['tag_late']);
    });
  });

  it('refuses malformed entries', async () => {
    await withPositions([BUY], async (test) => {
      const [position] = (await list(test)).positions;
      if (position === undefined) throw new Error('no position');
      const path = `/api/positions/${position.ref}/journal`;
      for (const bad of [
        { ...ENTRY, plannedRiskMicro: '0' },
        { ...ENTRY, initialStopMicro: '1.5' },
        { ...ENTRY, thesis: 'x'.repeat(10_001) },
        { ...ENTRY, extra: true },
        { thesis: 'missing the rest' },
      ]) {
        expect((await send(test, path, json('PUT', bad))).status).toBe(400);
      }
    });
  });

  it('asks which entry to edit when two collide on a position', async () => {
    await withPositions([BUY, SELL], async (test, vault) => {
      const [position] = (await list(test)).positions;
      if (position === undefined) throw new Error('no position');
      const path = `/api/positions/${position.ref}/journal`;
      expect((await send(test, path, json('PUT', ENTRY))).status).toBe(200);
      const [first] = (await detail(test, position.ref)).journal;
      if (first === undefined) throw new Error('no entry');
      // A second entry on the same anchor, as older history would bring (S10c).
      vault.db
        .prepare(
          `INSERT INTO journal_entry (id, anchor_account_id, anchor_instrument_key, anchor_bucket, anchor_key, status,
             created_at, updated_at)
           SELECT 'jnl_second', anchor_account_id, anchor_instrument_key, anchor_bucket, anchor_key, 'attached',
             '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z' FROM journal_entry WHERE id = ?`,
        )
        .run(first.id);
      vault.db
        .prepare(
          "INSERT INTO journal_attachment (journal_entry_id, position_id) SELECT 'jnl_second', position_id FROM journal_attachment WHERE journal_entry_id = ?",
        )
        .run(first.id);
      expect((await send(test, path, json('PUT', ENTRY))).status).toBe(409);
      expect(
        (await send(test, path, json('PUT', { ...ENTRY, entryId: 'jnl_second', thesis: 'B' }))).status,
      ).toBe(200);
      expect((await send(test, path, json('PUT', { ...ENTRY, entryId: 'jnl_other' }))).status).toBe(404);
      expect((await detail(test, position.ref)).journal.map((entry) => entry.thesis)).toEqual([null, 'B']);
      // Reviewing marks both.
      expect((await send(test, `/api/positions/${position.ref}/review`, { method: 'POST' })).status).toBe(
        200,
      );
      expect(
        vault.db.prepare('SELECT count(*) FROM journal_entry WHERE reviewed_at IS NOT NULL').pluck().get(),
      ).toBe(2n);
    });
  });
});
