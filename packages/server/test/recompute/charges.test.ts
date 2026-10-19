// S12a-2: recompute stores estimated charges for every allocation of an imported trade. The Dhan golden runs
// through the vault with the real orders, per day: STT and stamp duty equal the day's billed total rounded to the
// rupee (Dhan's per-scrip STT rows are a split of a rupee-rounded contract-note total, A1, so their sum can be a
// few paise off a whole rupee), and every other component is within rows x Rs 0.01 of the day's billed total (the
// per-row check is the core golden, packages/core/test/fees/golden.test.ts). Two differences are Dhan's and are
// pinned exactly (plan r12): STT on 18 Sep 2024 (billed Rs 40; the contract-note formula gives Rs 39, the one day
// research A1 could not match either) and GST on 9 May 2024 (Rs 0.02; it persists with the real orders).
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyCorporateActionAndRecompute } from '../../src/recompute/corporate-actions.js';
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
const DHAN_HEADER =
  'Date,Time,Name,Buy/Sell,Order,Exchange,Segment,Quantity/Lot,Trade Price,Trade Value,Status';
const ZERODHA_HEADER =
  'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';

interface Day {
  rows: bigint;
  readonly amounts: Record<Component, bigint>;
}

function microField(data: Readonly<Record<string, unknown>>, field: string): bigint {
  const value = data[field];
  if (typeof value !== 'string' || !/^-?\d+$/.test(value))
    throw new Error(`statement field ${field} is missing`);
  return BigInt(value);
}

/** What Global Transactions billed, per day and component, and how many scrip rows each day has. */
function billed(db: Database.Database): Map<string, Day> {
  const rows = db
    .prepare("SELECT key_json, data_json FROM statement_row WHERE kind = 'dhan.gt.row'")
    .all() as { key_json: string; data_json: string }[];
  const days = new Map<string, Day>();
  for (const row of rows) {
    const { date } = JSON.parse(row.key_json) as { date: string };
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    const day = days.get(date) ?? {
      rows: 0n,
      amounts: { brokerage: 0n, gst: 0n, stt: 0n, sebi: 0n, stamp_duty: 0n, exchange_txn: 0n, ipft: 0n },
    };
    day.rows += 1n;
    for (const [component, field] of Object.entries(COMPONENTS) as [Component, string][]) {
      day.amounts[component] += microField(data, field);
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

function chargeSet(db: Database.Database): unknown[] {
  return db
    .prepare(
      `SELECT t.dedup_key, a.bucket, c.component, c.amount_micro, c.rule_version FROM fill_charge c
       JOIN fill_allocation a ON a.id = c.fill_allocation_id JOIN trade_row t ON t.id = a.trade_row_id
       ORDER BY t.dedup_key, a.bucket, c.component`,
    )
    .all();
}

function compareDay(db: Database.Database, date: string, day: Day, hit: Set<string>): string[] {
  return (Object.keys(COMPONENTS) as Component[]).flatMap((component) => {
    const engine = charged(db, date, component);
    const statement = day.amounts[component];
    const rupees = component === 'stt' || component === 'stamp_duty';
    const expected = rupees ? ((statement + RUPEE / 2n) / RUPEE) * RUPEE : statement;
    const tolerance = rupees ? 0n : day.rows * PAISA;
    const difference = engine - expected;
    const known = KNOWN.get(`${date} ${component}`);
    if (known !== undefined) hit.add(`${date} ${component}`);
    const wrong =
      known !== undefined ? difference !== known : difference > tolerance || difference < -tolerance;
    return wrong ? [`${date} ${component} engine ${String(engine)} billed ${String(statement)}`] : [];
  });
}

describe('charges in recompute', () => {
  it('Dhan FY 2024-25 through the vault with the real orders matches Global Transactions day by day', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, DHAN, [
        fixtureFile('dhan', 'trade_history'),
        fixtureFile('dhan', 'global_transactions'),
        fixtureFile('dhan', 'tax_report', 'tax.xls'),
      ]);
      recompute(db, DHAN, { now });
      const days = billed(db);
      expect(days.size).toBe(46);
      const hit = new Set<string>();
      const misses = [...days].flatMap(([date, day]) => compareDay(db, date, day, hit));
      expect(misses).toEqual([]);
      expect([...hit].sort()).toEqual([...KNOWN.keys()].sort());
      // Nothing is charged on a FY 2024-25 day Dhan did not bill.
      const chargedDays = db
        .prepare(
          `SELECT DISTINCT t.trade_date_ist FROM fill_charge c JOIN fill_allocation a ON a.id = c.fill_allocation_id
           JOIN trade_row t ON t.id = a.trade_row_id WHERE t.trade_date_ist BETWEEN '2024-04-01' AND '2025-03-31'`,
        )
        .pluck()
        .all() as string[];
      expect(chargedDays.filter((date) => !days.has(date))).toEqual([]);
    });
  });

  it('every charge is an estimate tied to an imported trade, rebuilt identically by a recompute', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, DHAN, [fixtureFile('dhan', 'trade_history')]);
      recompute(db, DHAN, { now });
      expect(
        db
          .prepare(
            `SELECT DISTINCT c.source, a.trade_row_id IS NOT NULL AS from_trade,
               c.rule_version LIKE 'nse/%+dhan/%' AS versioned
             FROM fill_charge c JOIN fill_allocation a ON a.id = c.fill_allocation_id`,
          )
          .all(),
      ).toEqual([{ source: 'estimated', from_trade: 1n, versioned: 1n }]);
      const before = chargeSet(db);
      expect(before.length).toBeGreaterThan(0);
      recompute(db, DHAN, { now });
      expect(chargeSet(db)).toEqual(before);
    });
  });

  it('trades with no rule version in force (before 1 Apr 2024, or BSE before 1 Oct 2024) raise one fees_unrated issue', async () => {
    await withVault(async ({ db, service }) => {
      const lines = [
        '2024-03-28,10:00:00,Early Co,BUY,DELIVERY,NSE,Equity,1,100.00,100.00,Traded',
        '2024-09-02,10:00:00,Bse Co,BUY,DELIVERY,BSE,Equity,1,100.00,100.00,Traded',
        '2025-01-06,10:00:00,Rated Co,BUY,DELIVERY,NSE,Equity,10,10000.00,100000.00,Traded',
      ];
      await importFiles(service, DHAN, [{ bytes: Buffer.from([DHAN_HEADER, ...lines].join('\r\n')) }]);
      recompute(db, DHAN, { now });
      const issue = db
        .prepare("SELECT status, subject_json FROM issue WHERE kind = 'fees_unrated'")
        .get() as { status: string; subject_json: string };
      expect([issue.status, JSON.parse(issue.subject_json)]).toEqual(['open', { fills: 2 }]);
      expect(
        db
          .prepare(
            `SELECT DISTINCT t.trade_date_ist FROM fill_charge c JOIN fill_allocation a ON a.id = c.fill_allocation_id
             JOIN trade_row t ON t.id = a.trade_row_id`,
          )
          .pluck()
          .all(),
      ).toEqual(['2025-01-06']);
    });
  });

  it('charges of shares a corporate action cashed out are reported, never dropped', async () => {
    await withVault(async ({ db, service }) => {
      const buy = 'TCS,INE467B01029,2025-01-02,NSE,EQ,EQ,buy,false,3,1000,1,1,2025-01-02T10:00:00';
      await importFiles(service, ZERODHA, [{ bytes: Buffer.from(`${ZERODHA_HEADER}\r\n${buy}`) }]);
      recompute(db, ZERODHA, { now });
      const total = db.prepare('SELECT sum(amount_micro) FROM fill_charge').pluck().get() as bigint;
      applyCorporateActionAndRecompute(
        db,
        { type: 'SPLIT', isin: 'INE467B01029', exDateIst: '2025-03-03', ratioNum: '1', ratioDen: '10' },
        { now },
      );
      expect(count(db, 'fill_charge')).toBe(0);
      const subject = db
        .prepare("SELECT subject_json FROM issue WHERE kind = 'charges_unattached' AND status = 'open'")
        .pluck()
        .get() as string;
      expect(JSON.parse(subject)).toMatchObject({ totalMicro: total.toString() });
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
