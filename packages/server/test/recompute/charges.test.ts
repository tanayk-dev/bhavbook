// S12a-2: recompute stores estimated charges for every allocation of an imported trade, and the Dhan golden
// runs through the vault with the real orders: per day, STT and stamp duty equal what Global Transactions
// billed to the rupee, and every other component is within Rs 0.01 per scrip row of that day. Two differences are
// Dhan's and pinned exactly (plan r12): STT on 18 Sep 2024 (billed Rs 40; the contract-note formula gives Rs 39,
// the one day research A1 could not match either) and GST on 9 May 2024 (Rs 0.02; it persists with the real
// orders, so the order structure does not explain it).
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { recompute } from '../../src/recompute/index.js';
import { count, DHAN, fixtureFile, importFiles, withVault, ZERODHA } from '../import/helpers.js';

const now = (): Date => new Date('2026-10-20T12:00:00Z');
const PAISA = 10_000n;
const RUPEE = 1_000_000n;
const COMPONENTS = {
  brokerage: 'brokerage_micro',
  gst: 'gst_micro',
  stt: 'stt_micro',
  sebi: 'sebi_micro',
  stamp_duty: 'stamp_duty_micro',
  exchange_txn: 'txn_micro',
  ipft: 'other_micro',
} as const;
type Component = keyof typeof COMPONENTS;
/** engine - billed, for the two days Dhan's statement does not follow its own published rules. */
const KNOWN: ReadonlyMap<string, bigint> = new Map([
  ['2024-09-18 stt', -RUPEE],
  ['2024-05-09 gst', 2n * PAISA],
]);

/** What Global Transactions billed, per day and component, and how many scrip rows each day has. */
function billed(db: Database.Database): Map<string, { rows: bigint; amounts: Record<Component, bigint> }> {
  const rows = db
    .prepare("SELECT key_json, data_json FROM statement_row WHERE kind = 'dhan.gt.row'")
    .all() as { key_json: string; data_json: string }[];
  const days = new Map<string, { rows: bigint; amounts: Record<Component, bigint> }>();
  for (const row of rows) {
    const { date } = JSON.parse(row.key_json) as { date: string };
    const data = JSON.parse(row.data_json) as Record<string, string>;
    const day = days.get(date) ?? {
      rows: 0n,
      amounts: { brokerage: 0n, gst: 0n, stt: 0n, sebi: 0n, stamp_duty: 0n, exchange_txn: 0n, ipft: 0n },
    };
    day.rows += 1n;
    for (const [component, field] of Object.entries(COMPONENTS) as [Component, string][]) {
      day.amounts[component] += BigInt(data[field] ?? '0');
    }
    days.set(date, day);
  }
  return days;
}

function charged(db: Database.Database, date: string, component: Component): bigint {
  return db
    .prepare(
      `SELECT coalesce(sum(c.amount_micro), 0) FROM fill_charge c
       JOIN fill_allocation a ON a.id = c.fill_allocation_id JOIN trade_row t ON t.id = a.trade_row_id
       WHERE a.account_id = ? AND t.trade_date_ist = ? AND c.component = ? AND c.source = 'estimated'`,
    )
    .pluck()
    .get(DHAN, date, component) as bigint;
}

describe('charges in recompute', () => {
  it('Dhan FY 2024-25 through the vault: STT and stamp duty exact per day, the rest within Rs 0.01 per row', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, DHAN, [
        fixtureFile('dhan', 'trade_history'),
        fixtureFile('dhan', 'global_transactions'),
        fixtureFile('dhan', 'tax_report', 'tax.xls'),
      ]);
      recompute(db, DHAN, { now });
      const days = billed(db);
      expect(days.size).toBe(46);
      const misses: string[] = [];
      for (const [date, { rows, amounts }] of days) {
        for (const component of Object.keys(COMPONENTS) as Component[]) {
          const engine = charged(db, date, component);
          const statement = amounts[component];
          const rupees = component === 'stt' || component === 'stamp_duty';
          const expected = rupees ? ((statement + RUPEE / 2n) / RUPEE) * RUPEE : statement;
          const tolerance = rupees ? 0n : rows * PAISA;
          const difference = engine - expected;
          const known = KNOWN.get(`${date} ${component}`);
          if (
            known !== undefined ? difference !== known : difference > tolerance || difference < -tolerance
          ) {
            misses.push(`${date} ${component} engine ${String(engine)} billed ${String(statement)}`);
          }
        }
      }
      expect(misses).toEqual([]);
    });
  });

  it('every charge is an estimate tied to an imported trade, with its rule versions', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, DHAN, [fixtureFile('dhan', 'trade_history')]);
      recompute(db, DHAN, { now });
      expect(count(db, 'fill_charge')).toBeGreaterThan(0);
      expect(
        db
          .prepare(
            `SELECT DISTINCT c.source, a.trade_row_id IS NOT NULL AS from_trade, c.rule_version LIKE 'nse/%+dhan/%' AS versioned
             FROM fill_charge c JOIN fill_allocation a ON a.id = c.fill_allocation_id`,
          )
          .all(),
      ).toEqual([{ source: 'estimated', from_trade: 1n, versioned: 1n }]);
      // A recompute rebuilds them: same rows, no duplicates.
      const before = count(db, 'fill_charge');
      recompute(db, DHAN, { now });
      expect(count(db, 'fill_charge')).toBe(before);
    });
  });

  it('trades before the first rule version are flagged by one fees_unrated issue', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, DHAN, [fixtureFile('dhan', 'trade_history')]);
      recompute(db, DHAN, { now });
      const issue = db.prepare("SELECT status, subject_json FROM issue WHERE kind = 'fees_unrated'").get() as
        { status: string; subject_json: string } | undefined;
      const unratedTrades = count(
        db,
        'trade_row',
        "account_id = 'acc_dhan' AND trade_date_ist < '2024-04-01'",
      );
      if (unratedTrades === 0) {
        expect(issue).toBeUndefined();
      } else {
        expect(issue?.status).toBe('open');
        expect(JSON.parse(issue?.subject_json ?? '{}')).toMatchObject({ fills: unratedTrades });
      }
    });
  });

  it('Zerodha trades are charged with the Zerodha plan', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      recompute(db, ZERODHA, { now });
      const versions = db.prepare('SELECT DISTINCT rule_version FROM fill_charge ORDER BY 1').pluck().all();
      expect(versions.length).toBeGreaterThan(0);
      expect(
        versions.every((version) => typeof version === 'string' && version.endsWith('+zerodha/2024-06-01')),
      ).toBe(true);
    });
  });
});
