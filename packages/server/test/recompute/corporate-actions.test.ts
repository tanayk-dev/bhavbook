// S10b-2 (plan S10b tasks 2-4): corporate actions stored, applied in every account's recompute, revertible;
// suspicions and fractions surface as issues.
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  applyCorporateActionAndRecompute,
  restoreCorporateActionAndRecompute,
  revertCorporateActionAndRecompute,
} from '../../src/recompute/corporate-actions.js';
import { recompute } from '../../src/recompute/index.js';
import {
  CorporateActionError,
  createCorporateAction,
  previewCorporateActionInVault,
} from '../../src/services/corporate-actions.js';
import { count, importFiles, withVault, ZERODHA, type TestVault } from '../import/helpers.js';

const now = (): Date => new Date('2026-10-20T12:00:00Z');
const HEADER =
  'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';
const TCS = 'INE467B01029';
const NEW = 'INE000A01020';
const split = { type: 'SPLIT', isin: TCS, exDateIst: '2025-03-01', ratioNum: '5', ratioDen: '1' } as const;

let trade = 0;
function line(side: 'buy' | 'sell', qty: number, price: number, date: string, isin = TCS): string {
  trade += 1;
  return `TCS,${isin},${date},NSE,EQ,EQ,${side},false,${String(qty)},${String(price)},${String(trade)},${String(trade)},${date}T10:00:00`;
}

async function importLines(service: TestVault['service'], lines: readonly string[]): Promise<void> {
  await importFiles(service, ZERODHA, [{ bytes: Buffer.from([HEADER, ...lines].join('\r\n')) }]);
}

function issues(db: Database.Database, kind: string): { status: string; subject: unknown }[] {
  const rows = db
    .prepare('SELECT status, subject_json FROM issue WHERE kind = ? ORDER BY fingerprint')
    .all(kind) as { status: string; subject_json: string }[];
  return rows.map((row) => ({ status: row.status, subject: JSON.parse(row.subject_json) as unknown }));
}

function grossMicro(db: Database.Database): bigint {
  return db
    .prepare('SELECT sum(exit_value_micro - entry_value_micro) FROM lot WHERE exit_value_micro IS NOT NULL')
    .pluck()
    .get() as bigint;
}

describe('E8 through the vault', () => {
  it('a missed split is suspected; entering it completes the position; revert and restore', async () => {
    await withVault(async ({ db, service }) => {
      await importLines(service, [line('buy', 10, 500, '2025-01-02'), line('sell', 50, 110, '2025-04-01')]);
      expect(recompute(db, ZERODHA, { now }).incomplete).toBe(1);
      expect(issues(db, 'corporate_action_suspected')).toEqual([
        {
          status: 'open',
          subject: { kind: 'split_or_bonus', instrumentKey: TCS, dateIst: '2025-04-01', multiple: '5' },
        },
      ]);

      const id = applyCorporateActionAndRecompute(db, split, { now });
      expect(count(db, 'position', 'incomplete = 1')).toBe(0);
      expect(grossMicro(db)).toBe(500_000_000n);
      expect(issues(db, 'corporate_action_suspected').map((issue) => issue.status)).toEqual(['resolved']);

      revertCorporateActionAndRecompute(db, id, { now });
      expect(count(db, 'position', 'incomplete = 1')).toBe(1);
      restoreCorporateActionAndRecompute(db, id, { now });
      expect(count(db, 'position', 'incomplete = 1')).toBe(0);
    });
  });
});

describe('allocations and anchors', () => {
  it('a bonus lot is stored against its corporate action, with no trade behind it', async () => {
    await withVault(async ({ db, service }) => {
      await importLines(service, [line('buy', 10, 100, '2025-01-02')]);
      const id = applyCorporateActionAndRecompute(
        db,
        { type: 'BONUS', isin: TCS, exDateIst: '2025-03-01', allotmentDateIst: '2025-03-04', ratioNum: '1', ratioDen: '1' },
        { now },
      );
      expect(
        db
          .prepare('SELECT trade_row_id, adjustment_id, quantity, value_micro FROM fill_allocation WHERE corporate_action_id = ?')
          .all(id),
      ).toEqual([{ trade_row_id: null, adjustment_id: null, quantity: 10n, value_micro: 0n }]);
      expect(db.prepare('SELECT entry_date_ist FROM lot ORDER BY entry_date_ist').pluck().all()).toEqual([
        '2025-01-02',
        '2025-03-04',
      ]);
    });
  });

  it('after a partly sold conversion, a journal entry follows the live position on the new ISIN', async () => {
    await withVault(async ({ db, service }) => {
      await importLines(service, [line('buy', 10, 100, '2025-01-02'), line('sell', 4, 120, '2025-02-03')]);
      recompute(db, ZERODHA, { now });
      const anchor = db.prepare('SELECT anchor_key FROM position').pluck().get() as string;
      db.prepare(
        `INSERT INTO journal_entry (id, anchor_account_id, anchor_instrument_key, anchor_bucket, anchor_key, status,
           created_at, updated_at) VALUES ('j1', ?, ?, 'DELIVERY', ?, 'attached', 'x', 'x')`,
      ).run(ZERODHA, TCS, anchor);
      applyCorporateActionAndRecompute(
        db,
        { type: 'CONVERSION', isin: TCS, newIsin: NEW, exDateIst: '2025-03-01', ratioNum: '1', ratioDen: '1' },
        { now },
      );
      expect(db.prepare('SELECT instrument_key, state FROM position ORDER BY instrument_key').all()).toEqual([
        { instrument_key: NEW, state: 'OPEN' },
        { instrument_key: TCS, state: 'CLOSED' },
      ]);
      expect(db.prepare("SELECT anchor_instrument_key FROM journal_entry WHERE id = 'j1'").pluck().get()).toBe(NEW);
    });
  });
});

describe('fractions', () => {
  it('a fraction of a share is reported as a cash-in-lieu issue; reverting the action resolves it', async () => {
    await withVault(async ({ db, service }) => {
      await importLines(service, [line('buy', 7, 100, '2025-01-02')]);
      const id = applyCorporateActionAndRecompute(db, { ...split, ratioNum: '2', ratioDen: '3' }, { now });
      expect(issues(db, 'cash_in_lieu')).toEqual([
        {
          status: 'open',
          subject: {
            actionId: id,
            instrumentKey: TCS,
            bucket: 'DELIVERY',
            numerator: '2',
            denominator: '3',
            costRemovedMicro: '0',
          },
        },
      ]);
      revertCorporateActionAndRecompute(db, id, { now });
      expect(issues(db, 'cash_in_lieu').map((issue) => issue.status)).toEqual(['resolved']);
    });
  });
});

describe('the service', () => {
  it.each([
    ['an unknown type', { ...split, type: 'MERGER' }],
    ['a malformed ISIN', { ...split, isin: 'TCS' }],
    ['a zero ratio', { ...split, ratioNum: '0' }],
    ['an oversized ratio', { ...split, ratioNum: '10000000' }],
    ['an impossible date', { ...split, exDateIst: '2025-02-30' }],
    ['a conversion without its new ISIN', { ...split, type: 'CONVERSION' }],
    ['a demerger without its cost split', { ...split, type: 'DEMERGER', newIsin: NEW }],
    ['a cost split over 100%', { ...split, type: 'DEMERGER', newIsin: NEW, costSplitBp: '10001' }],
    ['a cost split on a split', { ...split, costSplitBp: '10' }],
    ['an unknown field', { ...split, extra: 1 }],
  ])('rejects %s, storing nothing', async (_, input) => {
    await withVault(({ db }) => {
      expect(() => createCorporateAction(db, input, { now })).toThrow(CorporateActionError);
      expect(count(db, 'corporate_action')).toBe(0);
    });
  });

  it('stores a double submit once', async () => {
    await withVault(({ db }) => {
      const first = createCorporateAction(db, split, { now });
      expect(createCorporateAction(db, split, { now })).toBe(first);
      expect(count(db, 'corporate_action')).toBe(1);
    });
  });

  it('refuses to revert what is not active, or restore what is not reverted', async () => {
    await withVault(({ db }) => {
      const id = createCorporateAction(db, split, { now });
      expect(() => restoreCorporateActionAndRecompute(db, id, { now })).toThrow(CorporateActionError);
      revertCorporateActionAndRecompute(db, id, { now });
      expect(() => revertCorporateActionAndRecompute(db, id, { now })).toThrow(CorporateActionError);
      expect(() => revertCorporateActionAndRecompute(db, 'nope', { now })).toThrow(CorporateActionError);
    });
  });

  it('reports a corrupt stored action as a fixed error, without its content', async () => {
    await withVault(async ({ db, service }) => {
      await importLines(service, [line('buy', 10, 100, '2025-01-02')]);
      const id = createCorporateAction(db, split, { now });
      db.prepare("UPDATE corporate_action SET ex_date = 'MARKER' WHERE id = ?").run(id);
      try {
        recompute(db, ZERODHA, { now });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(CorporateActionError);
        expect((error as Error).message).not.toContain('MARKER');
      }
    });
  });

  it('previews every account holding the ISIN, storing nothing', async () => {
    await withVault(async ({ db, service }) => {
      await importLines(service, [line('buy', 10, 100, '2025-01-02'), line('sell', 4, 120, '2025-02-03')]);
      recompute(db, ZERODHA, { now });
      const preview = previewCorporateActionInVault(db, split);
      expect(preview.before.map((lot) => [lot.accountId, lot.quantity, lot.costMicro])).toEqual([
        [ZERODHA, 6n, 600_000_000n],
      ]);
      expect(preview.after.map((lot) => lot.quantity)).toEqual([30n]);
      expect(count(db, 'corporate_action')).toBe(0);
    });
  });
});
