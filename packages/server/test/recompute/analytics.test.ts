// S15a golden (PRD §1 success signal): Dhan FY 2024-25 realised gross P&L from our lots, through the analytics core,
// against Dhan's own P&L report, scrip by scrip (by ISIN: the report and the trade file name some scrips
// differently, e.g. "REC" and "Rural Electrification Corporation"). Three scrips differ by paise, exactly as in the
// Tax Report golden (S9): Dhan's reports disagree with its own trade file there, and the trade file's value is
// authoritative (ADR-0008). So our total is the report's minus ₹0.03, and every other scrip matches to the paisa.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { realisedBy, type RealisedLot } from '@bhavbook/core';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { readDhanPnl } from '../../../adapters/test/golden/dhan-pnl.js';
import { recompute } from '../../src/recompute/index.js';
import { DHAN, FIXTURES, fixtureFile, importFiles, withVault } from '../import/helpers.js';

const now = (): Date => new Date('2026-10-21T12:00:00Z');

/** ours − report, micro-rupees: the same three scrips as the Tax Report golden (golden.test.ts). */
const REPORT_ROUNDING: ReadonlyMap<string, bigint> = new Map([
  ['INE175A01038', 50_000n],
  ['INE549A01026', -20_000n],
  ['INE093R01011', -60_000n],
]);

function pnlReport() {
  const file = path.join(FIXTURES, 'dhan', 'pnl', 'Dhan_P&L_01-04-2024_31-03-2025.csv');
  return readDhanPnl(readFileSync(file, 'utf8'));
}

/** A report scrip name's ISIN, through the aliases the import learned. */
function isinOf(db: Database.Database, name: string): string {
  const isin: unknown = db
    .prepare(
      `SELECT i.isin FROM instrument_alias a JOIN instrument i ON i.id = a.instrument_id
       WHERE a.broker = 'dhan' AND a.alias = ?`,
    )
    .pluck()
    .get(name);
  if (typeof isin !== 'string') throw new Error(`no ISIN for the report's scrip ${name}`);
  return isin;
}

describe('golden: Dhan FY 2024-25 realised P&L', () => {
  it("our realised gross equals Dhan's P&L report, scrip by scrip, apart from its three known paise", async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, DHAN, [
        fixtureFile('dhan', 'trade_history'),
        fixtureFile('dhan', 'global_transactions'),
        fixtureFile('dhan', 'dp_charges'),
        fixtureFile('dhan', 'tax_report', 'tax.xls'),
      ]);
      recompute(db, DHAN, { now });
      const rows = db
        .prepare(
          `SELECT l.position_id, l.exit_date_ist, l.exit_value_micro - l.entry_value_micro AS gross, p.instrument_key
           FROM lot l JOIN position p ON p.id = l.position_id
           WHERE l.exit_date_ist BETWEEN '2024-04-01' AND '2025-03-31'`,
        )
        .all() as { position_id: string; exit_date_ist: string; gross: bigint; instrument_key: string }[];
      const lots: RealisedLot[] = rows.map((row) => ({
        positionId: row.position_id,
        exitDateIst: row.exit_date_ist,
        grossMicro: row.gross,
        chargesMicro: 0n,
      }));
      const report = pnlReport();
      const ours = [...realisedBy(lots, 'month').values()].reduce((sum, month) => sum + month.grossMicro, 0n);
      expect(ours - report.grossMicro).toBe(-30_000n);

      const oursByIsin = new Map<string, bigint>();
      for (const row of rows) {
        oursByIsin.set(row.instrument_key, (oursByIsin.get(row.instrument_key) ?? 0n) + row.gross);
      }
      const theirsByIsin = new Map<string, bigint>();
      for (const [name, realised] of report.realised) {
        const isin = isinOf(db, name);
        theirsByIsin.set(isin, (theirsByIsin.get(isin) ?? 0n) + realised);
      }
      expect([...oursByIsin.keys()].sort()).toEqual([...theirsByIsin.keys()].sort());
      for (const [isin, value] of theirsByIsin) {
        expect([isin, (oursByIsin.get(isin) ?? 0n) - value]).toEqual([isin, REPORT_ROUNDING.get(isin) ?? 0n]);
      }
    });
  });
});
