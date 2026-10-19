// S10a-2 golden and service tests (plan S10a task 5): E11 full via "Fill from broker statement", E6/E7, the
// Zerodha INCOMPLETE positions completed by manual opening lots, revert, overrides and exclusions.
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  acceptStatementSuggestion,
  applyAdjustment,
  dismissIssue,
  replaceRedundantLot,
  restoreAndRecompute,
  revertAndRecompute,
} from '../../src/recompute/actions.js';
import { recompute } from '../../src/recompute/index.js';
import { AdjustmentError, createAdjustment } from '../../src/services/adjustments.js';
import {
  count,
  DHAN,
  fixtureBytes,
  fixtureFile,
  importFiles,
  withVault,
  ZERODHA,
} from '../import/helpers.js';

const now = (): Date => new Date('2026-10-19T12:00:00Z');
const ZERODHA_HEADER =
  'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';
const BAJAJ = 'INE377Y01014';

function openIssues(
  db: Database.Database,
  kind: string,
): { id: string; fingerprint: string; subject_json: string }[] {
  return db
    .prepare(
      "SELECT id, fingerprint, subject_json FROM issue WHERE kind = ? AND status = 'open' ORDER BY fingerprint",
    )
    .all(kind) as { id: string; fingerprint: string; subject_json: string }[];
}

function gross(db: Database.Database, isin: string, bucket: string, sellDate: string): bigint {
  return db
    .prepare(
      `SELECT sum(l.exit_value_micro - l.entry_value_micro) FROM lot l JOIN position p ON p.id = l.position_id
       WHERE p.instrument_key = ? AND p.bucket = ? AND l.exit_date_ist = ?`,
    )
    .pluck()
    .get(isin, bucket, sellDate) as bigint;
}

describe('E11 in full: the IPO lot from the Dhan Tax Report', () => {
  it('offers the Tax Report lot for the orphan sell; accepting it completes the delivery position at -Rs 390', async () => {
    await withVault(async ({ db, service }) => {
      // The export the PRD describes: the 17 Sep IPO allotment is not in the trade file (plan r7/r8).
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
      expect(recompute(db, DHAN, { now }).incomplete).toBe(1);
      const [offer] = openIssues(db, 'fill_from_statement');
      expect(JSON.parse(offer?.subject_json ?? '{}')).toMatchObject({
        instrumentKey: BAJAJ,
        bucket: 'DELIVERY',
        quantity: '200',
        totalCostMicro: '35200000000',
        entryDateIst: '2024-09-17',
      });
      const adjustment = acceptStatementSuggestion(db, offer?.id ?? '', { now });
      expect(db.prepare('SELECT source, status FROM adjustment WHERE id = ?').get(adjustment)).toEqual({
        source: 'broker_statement',
        status: 'active',
      });
      expect(recompute(db, DHAN, { now }).incomplete).toBe(0);
      expect(gross(db, BAJAJ, 'DELIVERY', '2024-09-18')).toBe(-390_000_000n);
      expect(gross(db, BAJAJ, 'INTRADAY', '2024-09-18')).toBe(-750_000_000n);
      expect(openIssues(db, 'fill_from_statement')).toEqual([]);
      expect(openIssues(db, 'incomplete_position')).toEqual([]);
    });
  });
});

describe('E6 and E7', () => {
  const sell = 'TCS,INE467B01029,2025-09-12,NSE,EQ,EQ,sell,false,10,120,1,10,2025-09-12T14:50:01';
  const olderBuy = 'TCS,INE467B01029,2025-08-01,NSE,EQ,EQ,buy,false,10,75,2,20,2025-08-01T10:00:00';

  it('E6 completes with an opening lot; E7 offers to replace it once the real buy is imported', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [{ bytes: Buffer.from(`${ZERODHA_HEADER}\r\n${sell}`) }]);
      const lot = applyAdjustment(
        db,
        ZERODHA,
        {
          kind: 'opening_lot',
          instrumentKey: 'INE467B01029',
          bucket: 'DELIVERY',
          quantity: '10',
          totalCostMicro: '800000000',
          beforeDateIst: '2025-09-12',
        },
        { now },
      );
      expect(recompute(db, ZERODHA, { now }).incomplete).toBe(0);
      expect(gross(db, 'INE467B01029', 'DELIVERY', '2025-09-12')).toBe(400_000_000n);
      expect(openIssues(db, 'opening_lot_redundant')).toEqual([]);

      await importFiles(service, ZERODHA, [{ bytes: Buffer.from(`${ZERODHA_HEADER}\r\n${olderBuy}`) }]);
      recompute(db, ZERODHA, { now });
      const [offer] = openIssues(db, 'opening_lot_redundant');
      expect(offer?.fingerprint).toBe(lot);
      // Never automatic: the lot is still active until the user replaces it.
      expect(db.prepare('SELECT status FROM adjustment WHERE id = ?').pluck().get(lot)).toBe('active');
      replaceRedundantLot(db, offer?.id ?? '', { now });
      expect(db.prepare('SELECT status FROM adjustment WHERE id = ?').pluck().get(lot)).toBe('superseded');
      expect(count(db, 'fill_allocation', 'adjustment_id IS NOT NULL')).toBe(0);
      expect(gross(db, 'INE467B01029', 'DELIVERY', '2025-09-12')).toBe(450_000_000n);
      expect(openIssues(db, 'opening_lot_redundant')).toEqual([]);
    });
  });
});

describe('Zerodha: the 10 INCOMPLETE positions', () => {
  it('all become complete with manual opening lots, and a revert restores INCOMPLETE', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      recompute(db, ZERODHA, { now });
      const incomplete = db
        .prepare(
          'SELECT instrument_key, bucket, orphan_qty FROM position WHERE account_id = ? AND incomplete = 1',
        )
        .all(ZERODHA) as { instrument_key: string; bucket: 'DELIVERY' | 'MTF'; orphan_qty: bigint }[];
      expect(incomplete).toHaveLength(10);
      const ids = incomplete.map((position) =>
        createAdjustment(
          db,
          ZERODHA,
          {
            kind: 'opening_lot',
            instrumentKey: position.instrument_key,
            bucket: position.bucket,
            quantity: position.orphan_qty.toString(),
            totalCostMicro: '1000000',
            beforeDateIst: '2025-09-12',
          },
          { now },
        ),
      );
      expect(recompute(db, ZERODHA, { now }).incomplete).toBe(0);
      expect(openIssues(db, 'incomplete_position')).toEqual([]);
      revertAndRecompute(db, ids[0] ?? '', { now });
      expect(count(db, 'position', 'incomplete = 1')).toBe(1);
      restoreAndRecompute(db, ids[0] ?? '', { now });
      expect(count(db, 'position', 'incomplete = 1')).toBe(0);
    });
  });
});

describe('overrides and exclusions', () => {
  const buy = 'TCS,INE467B01029,2025-09-12,NSE,EQ,EQ,buy,false,10,100,1,10,2025-09-12T10:00:00';
  const sell = 'TCS,INE467B01029,2025-09-12,NSE,EQ,EQ,sell,false,10,101,2,20,2025-09-12T11:00:00';

  it('a newer product override for the same day supersedes the older one', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [{ bytes: Buffer.from(`${ZERODHA_HEADER}\r\n${buy}\r\n${sell}`) }]);
      const override = {
        kind: 'product_override',
        instrumentKey: 'INE467B01029',
        tradeDateIst: '2025-09-12',
      } as const;
      const first = applyAdjustment(db, ZERODHA, { ...override, bucket: 'DELIVERY' }, { now });
      applyAdjustment(db, ZERODHA, { ...override, bucket: 'MTF' }, { now });
      expect(db.prepare('SELECT status FROM adjustment WHERE id = ?').pluck().get(first)).toBe('superseded');
      expect(db.prepare('SELECT DISTINCT bucket FROM position').pluck().all()).toEqual(['MTF']);
    });
  });

  it('an exclusion marks the position, and a revert clears it', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [{ bytes: Buffer.from(`${ZERODHA_HEADER}\r\n${buy}\r\n${sell}`) }]);
      recompute(db, ZERODHA, { now });
      const anchor = db.prepare('SELECT anchor_key FROM position').pluck().get() as string;
      const id = applyAdjustment(db, ZERODHA, { kind: 'exclude', anchorKey: anchor }, { now });
      expect(db.prepare('SELECT excluded FROM position').pluck().get()).toBe(1n);
      revertAndRecompute(db, id, { now });
      expect(db.prepare('SELECT excluded FROM position').pluck().get()).toBe(0n);
    });
  });
});

describe('validation and actions', () => {
  it.each([
    [
      {
        kind: 'opening_lot',
        instrumentKey: 'X',
        bucket: 'INTRADAY',
        quantity: '1',
        totalCostMicro: '1',
        beforeDateIst: '2025-01-01',
      },
    ],
    [
      {
        kind: 'opening_lot',
        instrumentKey: 'X',
        bucket: 'DELIVERY',
        quantity: '0',
        totalCostMicro: '1',
        beforeDateIst: '2025-01-01',
      },
    ],
    [
      {
        kind: 'opening_lot',
        instrumentKey: 'X',
        bucket: 'DELIVERY',
        quantity: '1',
        totalCostMicro: '-1',
        beforeDateIst: '2025-01-01',
      },
    ],
    [{ kind: 'opening_lot', instrumentKey: 'X', bucket: 'DELIVERY', quantity: '1', totalCostMicro: '1' }],
    [
      {
        kind: 'opening_lot',
        instrumentKey: 'X',
        bucket: 'DELIVERY',
        quantity: '1',
        totalCostMicro: '1',
        beforeDateIst: '2025-02-30',
      },
    ],
    [{ kind: 'product_override', instrumentKey: 'X', tradeDateIst: '2025-01-01', bucket: 'FOO' }],
    [{ kind: 'exclude', anchorKey: '' }],
    [{ kind: 'exclude', anchorKey: 'a', extra: 'field' }],
    [{ kind: 'mystery' }],
  ])('rejects %j without storing anything', async (input) => {
    await withVault(({ db }) => {
      expect(() => createAdjustment(db, ZERODHA, input, { now })).toThrow(AdjustmentError);
      expect(count(db, 'adjustment')).toBe(0);
    });
  });

  it('refuses unknown accounts, unknown or closed issues, and wrong transitions', async () => {
    await withVault(({ db }) => {
      const valid = { kind: 'exclude', anchorKey: 'a#DELIVERY' };
      expect(() => createAdjustment(db, 'nope', valid, { now })).toThrow(AdjustmentError);
      expect(() => acceptStatementSuggestion(db, 'missing', { now })).toThrow(AdjustmentError);
      expect(() => {
        replaceRedundantLot(db, 'missing', { now });
      }).toThrow(AdjustmentError);
      expect(() => {
        dismissIssue(db, 'missing');
      }).toThrow(AdjustmentError);
      const id = createAdjustment(db, ZERODHA, valid, { now });
      expect(() => {
        restoreAndRecompute(db, id, { now });
      }).toThrow(AdjustmentError);
      revertAndRecompute(db, id, { now });
      expect(() => {
        revertAndRecompute(db, id, { now });
      }).toThrow(AdjustmentError);
    });
  });

  it('dismissing a statement offer keeps it dismissed across recomputes', async () => {
    await withVault(async ({ db, service }) => {
      const trades = fixtureBytes('dhan', 'trade_history')
        .toString('utf8')
        .split(/\r?\n/)
        .filter((line) => !line.startsWith('2024-09-17,09:22:16,Bajaj Housing Finance'))
        .join('\r\n');
      await importFiles(service, DHAN, [
        { bytes: Buffer.from(trades) },
        fixtureFile('dhan', 'tax_report', 'tax.xls'),
      ]);
      recompute(db, DHAN, { now });
      const [offer] = openIssues(db, 'fill_from_statement');
      dismissIssue(db, offer?.id ?? '');
      recompute(db, DHAN, { now });
      expect(db.prepare('SELECT status FROM issue WHERE id = ?').pluck().get(offer?.id)).toBe('dismissed');
    });
  });
});
