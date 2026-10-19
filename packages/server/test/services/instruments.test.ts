// resolveInstruments / mapInstrumentManually (plan S8) on the anonymised fixtures, imported through the pipeline.
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  mapInstrumentManually,
  resolveInstruments,
  suggestForAlias,
} from '../../src/services/instruments.js';
import { DHAN, fixtureFile, importFiles, withVault, ZERODHA } from '../import/helpers.js';
import type { ImportService } from '../../src/import/index.js';

const REC = 'INE020B01018';
const HCC = 'INE549A01026';

async function importDhan(service: ImportService): Promise<void> {
  await importFiles(service, DHAN, [
    fixtureFile('dhan', 'trade_history'),
    fixtureFile('dhan', 'global_transactions'),
    fixtureFile('dhan', 'dp_charges'),
    fixtureFile('dhan', 'tax_report', 'tax.xls'),
  ]);
}

function isinOf(db: Database.Database, broker: string, alias: string): string | null {
  return (
    (db
      .prepare(
        `SELECT i.isin FROM instrument_alias a JOIN instrument i ON i.id = a.instrument_id
         WHERE a.broker = ? AND a.alias = ?`,
      )
      .pluck()
      .get(broker, alias) as string | null | undefined) ?? null
  );
}

function stateHash(db: Database.Database): string {
  const hash = createHash('sha256');
  for (const table of ['instrument', 'instrument_alias', 'issue']) {
    hash.update(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
  }
  return hash.digest('hex');
}

const now = (): Date => new Date('2026-10-19T12:00:00Z');

describe('resolveInstruments: Dhan', () => {
  it('resolves every FY 2024-25 trade-file name, with no ambiguity', async () => {
    await withVault(async ({ db, service }) => {
      await importDhan(service);
      const summary = resolveInstruments(db, DHAN, { now });
      const names = db
        .prepare(
          `SELECT DISTINCT broker_name FROM trade_row
           WHERE account_id = ? AND trade_date_ist BETWEEN '2024-04-01' AND '2025-03-31'`,
        )
        .pluck()
        .all(DHAN) as string[];
      expect(names).toHaveLength(36);
      for (const name of names)
        expect(isinOf(db, 'dhan', name), name.slice(0, 2)).toMatch(/^IN[A-Z0-9]{9}\d$/);
      expect(summary.unresolved.filter((entry) => entry.reason === 'ambiguous')).toEqual([]);
      expect(summary.unresolved.filter((entry) => names.includes(entry.alias))).toEqual([]);
    });
  });

  it('goes through the join for renamed scrips (REC, HCC)', async () => {
    await withVault(async ({ db, service }) => {
      await importDhan(service);
      resolveInstruments(db, DHAN, { now });
      expect(isinOf(db, 'dhan', 'Rural Electrification Corporation')).toBe(REC);
      expect(isinOf(db, 'dhan', 'HCC')).toBe(HCC);
      const sources = db
        .prepare(
          "SELECT alias, source FROM instrument_alias WHERE alias IN ('Rural Electrification Corporation', 'HCC', 'REC')",
        )
        .all() as { alias: string; source: string }[];
      expect(Object.fromEntries(sources.map((row) => [row.alias, row.source]))).toEqual({
        'Rural Electrification Corporation': 'join',
        HCC: 'join',
        REC: 'file',
      });
    });
  });

  it('raises one open issue per unresolved name, and resolves it once mapped', async () => {
    await withVault(async ({ db, service }) => {
      await importDhan(service);
      const { unresolved } = resolveInstruments(db, DHAN, { now });
      expect(unresolved.length).toBeGreaterThan(0);
      const issues = db
        .prepare(
          "SELECT fingerprint, status, subject_json FROM issue WHERE kind = 'unresolved_instrument' ORDER BY fingerprint",
        )
        .all() as { fingerprint: string; status: string; subject_json: string }[];
      expect(issues.map((issue) => issue.fingerprint)).toEqual(
        unresolved.map((entry) => `dhan:${entry.alias}`).sort(),
      );
      expect(issues.every((issue) => issue.status === 'open')).toBe(true);
      const [first] = unresolved;
      if (first === undefined) throw new Error('expected an unresolved name');
      mapInstrumentManually(db, { broker: 'dhan', alias: first.alias }, { isin: REC }, { now });
      expect(isinOf(db, 'dhan', first.alias)).toBe(REC);
      const status = db
        .prepare("SELECT status FROM issue WHERE kind = 'unresolved_instrument' AND fingerprint = ?")
        .pluck()
        .get(`dhan:${first.alias}`);
      expect(status).toBe('resolved');
      // A re-run never overrides a manual mapping, and the issue stays resolved.
      resolveInstruments(db, DHAN, { now });
      expect(isinOf(db, 'dhan', first.alias)).toBe(REC);
      expect(
        db
          .prepare("SELECT source FROM instrument_alias WHERE broker = 'dhan' AND alias = ?")
          .pluck()
          .get(first.alias),
      ).toBe('manual');
    });
  });

  it('keeps a dismissed issue dismissed, and is idempotent', async () => {
    await withVault(async ({ db, service }) => {
      await importDhan(service);
      resolveInstruments(db, DHAN, { now });
      db.prepare("UPDATE issue SET status = 'dismissed' WHERE id = (SELECT min(id) FROM issue)").run();
      const before = stateHash(db);
      resolveInstruments(db, DHAN, { now });
      expect(stateHash(db)).toBe(before);
    });
  });
});

describe('resolveInstruments: Zerodha', () => {
  it('fills the FIVESTAR/ADVANCE blank ISINs from the same symbol and leaves nothing unresolved', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      const summary = resolveInstruments(db, ZERODHA, { now });
      expect(isinOf(db, 'zerodha', 'FIVESTAR')).toBe('INE128S01021');
      expect(isinOf(db, 'zerodha', 'ADVANCE')).toBe('INE1B0W01010');
      expect(summary.unresolved).toEqual([]);
      const symbols = db
        .prepare('SELECT count(DISTINCT broker_symbol) FROM trade_row WHERE account_id = ?')
        .pluck()
        .get(ZERODHA) as bigint;
      expect(BigInt(summary.resolved)).toBe(symbols);
    });
  });
});

describe('manual mapping', () => {
  it('suggests instruments by name overlap and acronym', async () => {
    await withVault(async ({ db, service }) => {
      await importDhan(service);
      resolveInstruments(db, DHAN, { now });
      const [top] = suggestForAlias(db, { broker: 'dhan', alias: 'HCC Ltd' });
      expect(top?.isin).toBe(HCC);
    });
  });

  it('can create an instrument without an ISIN', async () => {
    await withVault(({ db }) => {
      mapInstrumentManually(
        db,
        { broker: 'dhan', alias: 'Unlisted Co' },
        { newDisplayName: 'Unlisted Co' },
        { now },
      );
      const row = db
        .prepare(
          `SELECT i.isin, i.display_name, a.source FROM instrument_alias a JOIN instrument i ON i.id = a.instrument_id
           WHERE a.alias = 'Unlisted Co'`,
        )
        .get();
      expect(row).toEqual({ isin: null, display_name: 'Unlisted Co', source: 'manual' });
    });
  });

  it('rejects a malformed ISIN', async () => {
    await withVault(({ db }) => {
      expect(() => {
        mapInstrumentManually(db, { broker: 'dhan', alias: 'X' }, { isin: 'not-an-isin' }, { now });
      }).toThrow();
    });
  });
});
