// S9-2 review follow-ups: recompute failures never fail a committed import, the forecast is advisory and never
// writes, INCOMPLETE issues survive re-keying, and alias changes recompute every account of the broker.
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { forecastIssues, recompute, recomputeHooks, remapInstrument } from '../../src/recompute/index.js';
import { count, DHAN, fixtureFile, importFiles, withVault, ZERODHA } from '../import/helpers.js';

const now = (): Date => new Date('2026-10-19T12:00:00Z');
const DHAN_HEADER =
  'Date,Time,Name,Buy/Sell,Order,Exchange,Segment,Quantity/Lot,Trade Price,Trade Value,Status';

function everyTableHash(db: Database.Database): string {
  const hash = createHash('sha256');
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck()
    .all() as string[];
  for (const table of tables) {
    hash.update(table);
    hash.update(
      JSON.stringify(db.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all(), (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  }
  return hash.digest('hex');
}

describe('recompute failures', () => {
  it('are recorded as an issue instead of failing the committed import, and cleared by the next recompute', async () => {
    await withVault(
      async ({ db, service }) => {
        db.exec(
          "CREATE TEMP TRIGGER boom BEFORE INSERT ON main.position BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        );
        const preview = await service.previewImport(ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
        expect(service.commitImport(preview.token ?? '').batches).toHaveLength(1);
        expect(count(db, 'trade_row')).toBe(121);
        expect(db.prepare("SELECT status FROM issue WHERE kind = 'recompute_failed'").pluck().all()).toEqual([
          'open',
        ]);
        db.exec('DROP TRIGGER temp.boom');
        recompute(db, ZERODHA, { now });
        expect(db.prepare("SELECT status FROM issue WHERE kind = 'recompute_failed'").pluck().all()).toEqual([
          'resolved',
        ]);
      },
      {},
      (db) => recomputeHooks(db, { now }),
    );
  });
});

describe('the issue forecast', () => {
  it('never fails a preview: a failing forecaster gives a warning', async () => {
    await withVault(
      async ({ service }) => {
        const [file] = (await service.previewImport(ZERODHA, [fixtureFile('zerodha', 'tradebook')])).files;
        expect(file).toMatchObject({
          status: 'ready',
          warnings: ['forecast_unavailable'],
          issueForecast: [],
        });
      },
      {
        forecast: () => {
          throw new Error('boom');
        },
      },
    );
  });

  it('is skipped for a file that adds nothing new', async () => {
    const forecast = vi.fn(() => []);
    await withVault(
      async ({ service }) => {
        await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
        forecast.mockClear();
        await service.previewImport(ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
        expect(forecast).not.toHaveBeenCalled();
      },
      { forecast },
    );
  });

  it('writes nothing to any table (Dhan: it resolves instruments in the dry run), also inside a transaction', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, DHAN, [fixtureFile('dhan', 'trade_history')]);
      recompute(db, DHAN, { now });
      const before = everyTableHash(db);
      const preview = await service.previewImport(DHAN, [fixtureFile('dhan', 'tax_report', 'tax.xls')]);
      expect(preview.files[0]?.status).toBe('ready');
      const result = {
        rows: [],
        statements: [],
        instrumentHints: [],
        skipped: [],
        errors: [],
        coverage: null,
      };
      forecastIssues(db, DHAN, result, { now });
      db.transaction(() => forecastIssues(db, DHAN, result, { now }))();
      expect(everyTableHash(db)).toBe(before);
    });
  });
});

describe('re-keying', () => {
  it('keeps a dismissed INCOMPLETE issue dismissed when its instrument is resolved later', async () => {
    await withVault(async ({ db, service }) => {
      const orphan = '2025-01-02,10:00:00,Mystery Scrip,SELL,DELIVERY,NSE,Equity,5,100.00,500.00,Traded';
      await importFiles(service, DHAN, [{ bytes: Buffer.from(`${DHAN_HEADER}\r\n${orphan}`) }]);
      recompute(db, DHAN, { now });
      db.prepare("UPDATE issue SET status = 'dismissed' WHERE kind = 'incomplete_position'").run();
      remapInstrument(
        db,
        DHAN,
        { broker: 'dhan', alias: 'Mystery Scrip' },
        { isin: 'INE020B01018' },
        { now },
      );
      expect(db.prepare('SELECT instrument_key FROM position').pluck().all()).toEqual(['INE020B01018']);
      expect(db.prepare("SELECT status FROM issue WHERE kind = 'incomplete_position'").pluck().all()).toEqual(
        ['dismissed'],
      );
    });
  });

  it('recomputes every account of the broker when a mapping changes', async () => {
    await withVault(async ({ db, service }) => {
      db.prepare(
        "INSERT INTO broker_account (id, profile_id, broker, nickname, created_at) VALUES ('acc_dhan2', 'prof1', 'dhan', 'D two', 'x')",
      ).run();
      const buy = '2025-01-02,10:00:00,Mystery Scrip,BUY,DELIVERY,NSE,Equity,5,100.00,500.00,Traded';
      await importFiles(service, 'acc_dhan2', [{ bytes: Buffer.from(`${DHAN_HEADER}\r\n${buy}`) }]);
      recompute(db, 'acc_dhan2', { now });
      remapInstrument(
        db,
        DHAN,
        { broker: 'dhan', alias: 'Mystery Scrip' },
        { isin: 'INE020B01018' },
        { now },
      );
      expect(
        db.prepare("SELECT instrument_key FROM position WHERE account_id = 'acc_dhan2'").pluck().all(),
      ).toEqual(['INE020B01018']);
    });
  });
});
