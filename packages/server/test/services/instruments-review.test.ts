// S8 review follow-ups: manual mappings are final (with or without an ISIN), a join that contradicts an existing
// mapping is raised as a conflict, and dismissed issues stay dismissed.
import { describe, expect, it } from 'vitest';
import { mapInstrumentManually, resolveInstruments } from '../../src/services/instruments.js';
import { DHAN, fixtureFile, importFiles, withVault } from '../import/helpers.js';

const now = (): Date => new Date('2026-10-19T12:00:00Z');
const HCC = 'INE549A01026';
const REC = 'INE020B01018';

async function importDhan(service: Parameters<typeof importFiles>[0]): Promise<void> {
  await importFiles(service, DHAN, [
    fixtureFile('dhan', 'trade_history'),
    fixtureFile('dhan', 'global_transactions'),
    fixtureFile('dhan', 'dp_charges'),
    fixtureFile('dhan', 'tax_report', 'tax.xls'),
  ]);
}

describe('manual mappings are final', () => {
  it('a mapping to a new instrument without an ISIN keeps its issue resolved on re-runs', async () => {
    await withVault(async ({ db, service }) => {
      await importDhan(service);
      const [first] = resolveInstruments(db, DHAN, { now }).unresolved;
      if (first === undefined) throw new Error('expected an unresolved name');
      mapInstrumentManually(db, { broker: 'dhan', alias: first.alias }, { newDisplayName: first.alias }, { now });
      const summary = resolveInstruments(db, DHAN, { now });
      expect(summary.unresolved.map((entry) => entry.alias)).not.toContain(first.alias);
      const status = db
        .prepare("SELECT status FROM issue WHERE kind = 'unresolved_instrument' AND fingerprint = ?")
        .pluck()
        .get(`dhan:${first.alias}`);
      expect(status).toBe('resolved');
    });
  });

  it('a manual mapping is not reported or shadowed by a join that disagrees', async () => {
    await withVault(async ({ db, service }) => {
      await importDhan(service);
      mapInstrumentManually(db, { broker: 'dhan', alias: 'HCC' }, { isin: REC }, { now });
      resolveInstruments(db, DHAN, { now });
      const isin = db
        .prepare(
          `SELECT i.isin FROM instrument_alias a JOIN instrument i ON i.id = a.instrument_id
           WHERE a.broker = 'dhan' AND a.alias = 'HCC'`,
        )
        .pluck()
        .get();
      expect(isin).toBe(REC);
      expect(
        db.prepare("SELECT count(*) FROM issue WHERE fingerprint = 'dhan:HCC' AND status = 'open'").pluck().get(),
      ).toBe(0n);
    });
  });
});

describe('contradicting evidence', () => {
  it('raises a conflict when the join now disagrees with an earlier automatic mapping, keeping the old one', async () => {
    await withVault(async ({ db, service }) => {
      await importDhan(service);
      resolveInstruments(db, DHAN, { now });
      // Simulate an earlier, different automatic mapping for HCC.
      db.prepare("INSERT INTO instrument (id, isin, display_name) VALUES ('ins_INE000000017', 'INE000000017', 'Old')").run();
      db.prepare(
        "UPDATE instrument_alias SET instrument_id = 'ins_INE000000017' WHERE broker = 'dhan' AND alias = 'HCC'",
      ).run();
      const summary = resolveInstruments(db, DHAN, { now });
      expect(summary.unresolved).toContainEqual({
        alias: 'HCC',
        reason: 'conflict',
        candidates: ['INE000000017', HCC],
      });
      const issue = db
        .prepare("SELECT status FROM issue WHERE kind = 'unresolved_instrument' AND fingerprint = 'dhan:HCC'")
        .pluck()
        .get();
      expect(issue).toBe('open');
    });
  });
});

describe('issue lifecycle', () => {
  it('keeps a dismissed issue dismissed across re-runs', async () => {
    await withVault(async ({ db, service }) => {
      await importDhan(service);
      resolveInstruments(db, DHAN, { now });
      const id = db.prepare("SELECT id FROM issue WHERE status = 'open' ORDER BY id LIMIT 1").pluck().get() as string;
      db.prepare("UPDATE issue SET status = 'dismissed' WHERE id = ?").run(id);
      resolveInstruments(db, DHAN, { now });
      expect(db.prepare('SELECT status FROM issue WHERE id = ?').pluck().get(id)).toBe('dismissed');
    });
  });
});
