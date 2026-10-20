// S12b (ADR-0017, PRD §8.2) through the vault: Dhan Global Transactions reconciles the engine's estimates, reported
// charges are rebuilt by every recompute, positions get FEES_RECONCILED / FEES_DISCREPANCY / FEES_ESTIMATED, and the
// Tax Report lots cross-check our FIFO lots. The two differences that remain in FY 2024-25 are Dhan's own billing
// (plan r12): STT on 18 Sep 2024 (billed ₹40, its published formula gives ₹39) and GST on 9 May 2024 (₹0.02).
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { acceptStatementSuggestion } from '../../src/recompute/actions.js';
import { recompute } from '../../src/recompute/index.js';
import { DHAN, fixtureBytes, fixtureFile, importFiles, withVault, ZERODHA } from '../import/helpers.js';

const now = (): Date => new Date('2026-10-21T12:00:00Z');
const RUPEE = 1_000_000n;
const BAJAJ = 'INE377Y01014';
const GT_FIELDS = {
  brokerage: 'brokerage_micro',
  stt: 'stt_micro',
  exchange_txn: 'txn_micro',
  sebi: 'sebi_micro',
  ipft: 'other_micro',
  stamp_duty: 'stamp_duty_micro',
  gst: 'gst_micro',
} as const;

function statuses(db: Database.Database): Record<string, bigint> {
  const rows = db
    .prepare('SELECT status, count(*) AS n FROM charge_reconciliation GROUP BY status')
    .all() as {
    status: string;
    n: bigint;
  }[];
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

function openIssues(db: Database.Database, kind: string): { fingerprint: string; subject: unknown }[] {
  const rows = db
    .prepare(
      "SELECT fingerprint, subject_json FROM issue WHERE kind = ? AND status = 'open' ORDER BY fingerprint",
    )
    .all(kind) as { fingerprint: string; subject_json: string }[];
  return rows.map((row) => ({
    fingerprint: row.fingerprint,
    subject: JSON.parse(row.subject_json) as unknown,
  }));
}

const discrepancies = (db: Database.Database) =>
  openIssues(db, 'fee_discrepancy').map((issue) => issue.subject);

async function importDhan(
  service: Parameters<typeof importFiles>[0],
  trades = fixtureFile('dhan', 'trade_history'),
) {
  await importFiles(service, DHAN, [
    trades,
    fixtureFile('dhan', 'global_transactions'),
    fixtureFile('dhan', 'tax_report', 'tax.xls'),
  ]);
}

describe('Dhan FY 2024-25 reconciled against Global Transactions', () => {
  it("every covered position reconciles except Dhan's two own billing differences; later trades stay estimated", async () => {
    await withVault(async ({ db, service }) => {
      await importDhan(service);
      recompute(db, DHAN, { now });
      expect(statuses(db)).toEqual({ FEES_RECONCILED: 43n, FEES_DISCREPANCY: 3n, FEES_ESTIMATED: 8n });
      expect(discrepancies(db)).toEqual(
        expect.arrayContaining([
          {
            instrumentKey: 'INE175A01038',
            bucket: 'INTRADAY',
            discrepancies: [
              {
                scope: 'row',
                dateIst: '2024-05-09',
                instrumentKey: 'INE175A01038',
                component: 'gst',
                estimatedMicro: '8040000',
                reportedMicro: '8020000',
              },
            ],
          },
          {
            instrumentKey: BAJAJ,
            bucket: 'DELIVERY',
            discrepancies: [
              {
                scope: 'day',
                dateIst: '2024-09-18',
                instrumentKey: null,
                component: 'stt',
                estimatedMicro: '39000000',
                reportedMicro: '40000000',
              },
            ],
          },
          expect.objectContaining({ instrumentKey: BAJAJ, bucket: 'INTRADAY' }),
        ]),
      );
      expect(discrepancies(db)).toHaveLength(3);
      // Trades before 22 Apr 2024 are not in the trade file, so no statement row is left over.
      expect(
        openIssues(db, 'fee_discrepancy').filter((issue) => issue.fingerprint.startsWith('statement:')),
      ).toEqual([]);
    });
  });

  it('the reported charges equal Global Transactions exactly, every day and component, and survive a recompute', async () => {
    await withVault(async ({ db, service }) => {
      await importDhan(service);
      recompute(db, DHAN, { now });
      const billed = new Map<string, bigint>();
      const rows = db
        .prepare("SELECT key_json, data_json FROM statement_row WHERE kind = 'dhan.gt.row'")
        .all() as { key_json: string; data_json: string }[];
      for (const row of rows) {
        const { date } = JSON.parse(row.key_json) as { date: string };
        const data = JSON.parse(row.data_json) as Record<string, string>;
        for (const [component, field] of Object.entries(GT_FIELDS)) {
          const key = `${date} ${component}`;
          billed.set(key, (billed.get(key) ?? 0n) + BigInt(data[field] ?? '0'));
        }
      }
      const reported = () =>
        new Map(
          (
            db
              .prepare(
                `SELECT t.trade_date_ist || ' ' || c.component AS key, sum(c.amount_micro) AS total FROM fill_charge c
                 JOIN fill_allocation a ON a.id = c.fill_allocation_id JOIN trade_row t ON t.id = a.trade_row_id
                 WHERE c.source = 'reported' GROUP BY 1`,
              )
              .all() as { key: string; total: bigint }[]
          ).map((row) => [row.key, row.total]),
        );
      const first = reported();
      for (const [key, total] of billed) expect([key, first.get(key) ?? 0n]).toEqual([key, total]);
      recompute(db, DHAN, { now });
      expect(reported()).toEqual(first);
    });
  });

  it('an injected ₹1 brokerage difference is a discrepancy on that position, and the reported value is used', async () => {
    await withVault(async ({ db, service }) => {
      await importDhan(service);
      const row = db
        .prepare(
          "SELECT id, key_json, data_json FROM statement_row WHERE kind = 'dhan.gt.row' AND key_json LIKE '%2024-06-25%'",
        )
        .get() as { id: bigint; key_json: string; data_json: string };
      const data = JSON.parse(row.data_json) as Record<string, string>;
      const brokerage = BigInt(data.brokerage_micro ?? '0');
      db.prepare('UPDATE statement_row SET data_json = ? WHERE id = ?').run(
        JSON.stringify({ ...data, brokerage_micro: String(brokerage + RUPEE) }),
        row.id,
      );
      recompute(db, DHAN, { now });
      const injected = discrepancies(db).flatMap(
        (subject) => (subject as { discrepancies: { dateIst: string; component: string }[] }).discrepancies,
      );
      expect(injected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ dateIst: '2024-06-25', component: 'brokerage', scope: 'row' }),
        ]),
      );
      const used = db
        .prepare(
          `SELECT sum(c.amount_micro) FROM fill_charge c JOIN fill_allocation a ON a.id = c.fill_allocation_id
           JOIN trade_row t ON t.id = a.trade_row_id
           WHERE t.trade_date_ist = '2024-06-25' AND c.component = 'brokerage' AND c.source = 'reported'`,
        )
        .pluck()
        .get() as bigint;
      const billedThatDay = (
        db
          .prepare(
            "SELECT data_json FROM statement_row WHERE kind = 'dhan.gt.row' AND key_json LIKE '%2024-06-25%'",
          )
          .pluck()
          .all() as string[]
      ).reduce(
        (sum, json) => sum + BigInt((JSON.parse(json) as Record<string, string>).brokerage_micro ?? '0'),
        0n,
      );
      expect(used).toBe(billedThatDay);
    });
  });

  it('without a statement every position is estimated and nothing is reported', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, DHAN, [fixtureFile('dhan', 'trade_history')]);
      recompute(db, DHAN, { now });
      expect(statuses(db)).toEqual({ FEES_ESTIMATED: 54n });
      expect(db.prepare("SELECT count(*) FROM fill_charge WHERE source = 'reported'").pluck().get()).toBe(0n);
      expect(openIssues(db, 'fee_discrepancy')).toEqual([]);
    });
  });
});

describe('the FIFO cross-check against the Tax Report', () => {
  it('is clean on the full fixture', async () => {
    await withVault(async ({ db, service }) => {
      await importDhan(service);
      recompute(db, DHAN, { now });
      expect(openIssues(db, 'fifo_mismatch')).toEqual([]);
    });
  });

  it('flags the IPO lot while the allotment is missing, and is clean once the Tax Report lot is accepted', async () => {
    await withVault(async ({ db, service }) => {
      const trades = fixtureBytes('dhan', 'trade_history')
        .toString('utf8')
        .split(/\r?\n/)
        .filter((line) => !line.startsWith('2024-09-17,09:22:16,Bajaj Housing Finance'))
        .join('\r\n');
      await importDhan(service, { bytes: Buffer.from(trades) });
      recompute(db, DHAN, { now });
      expect(openIssues(db, 'fifo_mismatch').map((issue) => issue.subject)).toEqual([
        {
          isin: BAJAJ,
          buyDateIst: '2024-09-17',
          sellDateIst: '2024-09-18',
          ourQuantity: '0',
          statementQuantity: '200',
          ourValueMicro: '0',
          statementValueMicro: '35200000000',
        },
      ]);
      const offer = db
        .prepare("SELECT id FROM issue WHERE kind = 'fill_from_statement' AND status = 'open'")
        .pluck()
        .get() as string;
      acceptStatementSuggestion(db, offer, { now });
      expect(openIssues(db, 'fifo_mismatch')).toEqual([]);
    });
  });
});

describe('Zerodha', () => {
  it('positions stay estimated: no Zerodha charge statement is reconciled in v1', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      recompute(db, ZERODHA, { now });
      expect(Object.keys(statuses(db))).toEqual(['FEES_ESTIMATED']);
    });
  });

  // TODO(PRD §16): needs a FY 2025-26 Tax P&L sample whose period the tradebook covers. Then verify ±₹0.01 per lot
  // and ±₹0.05 per (exit date, instrument), and reconcile Zerodha charges from it.
  it.skip('Tax P&L charges reconcile within ±₹0.01 per lot and ±₹0.05 per (exit date, instrument)', () => {
    expect.fail('needs the FY 2025-26 Tax P&L sample');
  });
});
