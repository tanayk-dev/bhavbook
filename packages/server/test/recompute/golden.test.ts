// Golden tests (plan S9 task 6) on the anonymised real fixtures, imported through the pipeline.
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { recompute } from '../../src/recompute/index.js';
import { DHAN, fixtureFile, importFiles, withVault, ZERODHA } from '../import/helpers.js';
import type { ImportService } from '../../src/import/index.js';

async function importDhan(service: ImportService): Promise<void> {
  await importFiles(service, DHAN, [
    fixtureFile('dhan', 'trade_history'),
    fixtureFile('dhan', 'global_transactions'),
    fixtureFile('dhan', 'dp_charges'),
    fixtureFile('dhan', 'tax_report', 'tax.xls'),
  ]);
}

interface LotRow {
  readonly isin: string;
  readonly section: string;
  readonly buy: string;
  readonly sell: string;
  readonly qty: string;
  readonly buyValue: bigint;
  readonly sellValue: bigint;
}

/** Our closed lots in FY 2024-25, grouped like the Tax Report (ISIN, section, buy date, sell date). */
function ourLots(db: Database.Database): LotRow[] {
  const rows = db
    .prepare(
      `SELECT p.instrument_key AS isin, CASE p.bucket WHEN 'INTRADAY' THEN 'intraday' ELSE 'short_term' END AS section,
              l.entry_date_ist AS buy, l.exit_date_ist AS sell, sum(l.quantity) AS qty,
              sum(l.entry_value_micro) AS buyValue, sum(l.exit_value_micro) AS sellValue
       FROM lot l JOIN position p ON p.id = l.position_id
       WHERE p.account_id = ? AND l.exit_date_ist BETWEEN '2024-04-01' AND '2025-03-31'
       GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`,
    )
    .all(DHAN) as {
    isin: string;
    section: string;
    buy: string;
    sell: string;
    qty: bigint;
    buyValue: bigint;
    sellValue: bigint;
  }[];
  return rows.map((row) => ({ ...row, qty: row.qty.toString() }));
}

/** Dhan's own FIFO lots from the Tax Report, grouped the same way. */
function taxReportLots(db: Database.Database): LotRow[] {
  const rows = db
    .prepare("SELECT key_json, data_json FROM statement_row WHERE kind = 'dhan.tax.lot'")
    .all() as {
    key_json: string;
    data_json: string;
  }[];
  const grouped = new Map<string, LotRow>();
  for (const row of rows) {
    const key = JSON.parse(row.key_json) as Record<string, string>;
    const data = JSON.parse(row.data_json) as Record<string, string>;
    const lot: LotRow = {
      isin: key.isin ?? '',
      section: key.section ?? '',
      buy: key.buy_date ?? '',
      sell: key.sell_date ?? '',
      qty: key.quantity ?? '',
      buyValue: BigInt(data.buy_value_micro ?? '0'),
      sellValue: BigInt(data.sell_value_micro ?? '0'),
    };
    const id = [lot.isin, lot.section, lot.buy, lot.sell].join('|');
    const seen = grouped.get(id);
    grouped.set(
      id,
      seen === undefined
        ? lot
        : {
            ...seen,
            qty: (BigInt(seen.qty) + BigInt(lot.qty)).toString(),
            buyValue: seen.buyValue + lot.buyValue,
            sellValue: seen.sellValue + lot.sellValue,
          },
    );
  }
  return [...grouped.values()].sort((a, b) =>
    [a.isin, a.section, a.buy, a.sell].join('|') < [b.isin, b.section, b.buy, b.sell].join('|') ? -1 : 1,
  );
}

/**
 * Three lots where Dhan's Tax Report and its trade file disagree by a few paise. They are the same three scrips
 * whose values also differ in Global Transactions (S8): a difference between Dhan's reports, not a matching
 * difference. The trade file's Trade Value is authoritative (ADR-0008). Exact deltas (ours - report, micro-rupees).
 */
const REPORT_ROUNDING: ReadonlyMap<string, { buy: bigint; sell: bigint }> = new Map([
  ['INE175A01038|2024-05-09|2024-05-09', { buy: -50_000n, sell: 0n }],
  ['INE549A01026|2024-06-25|2024-06-25', { buy: 0n, sell: -20_000n }],
  ['INE093R01011|2024-06-21|2024-06-24', { buy: 0n, sell: -60_000n }],
]);

describe('golden: Dhan FY 2024-25 lots equal the Tax Report', () => {
  it('matches every Tax Report lot on ISIN, section, dates and quantity, and on value to the paisa', async () => {
    await withVault(async ({ db, service }) => {
      await importDhan(service);
      recompute(db, DHAN);
      const ours = ourLots(db);
      const theirs = taxReportLots(db);
      expect(db.prepare("SELECT count(*) FROM statement_row WHERE kind = 'dhan.tax.lot'").pluck().get()).toBe(
        46n,
      );
      expect(theirs).toHaveLength(46);
      expect(ours.map(({ isin, section, buy, sell, qty }) => ({ isin, section, buy, sell, qty }))).toEqual(
        theirs.map(({ isin, section, buy, sell, qty }) => ({ isin, section, buy, sell, qty })),
      );
      let exact = 0;
      ours.forEach((lot, index) => {
        const report = theirs[index];
        if (report === undefined) throw new Error('lot count mismatch');
        const id = `${lot.isin}|${lot.buy}|${lot.sell}`;
        const delta = REPORT_ROUNDING.get(id);
        if (delta !== undefined) {
          expect({ buy: lot.buyValue - report.buyValue, sell: lot.sellValue - report.sellValue }).toEqual(
            delta,
          );
        } else {
          expect([id, lot.buyValue, lot.sellValue]).toEqual([id, report.buyValue, report.sellValue]);
          exact += 1;
        }
      });
      expect(exact).toBe(43);
    });
  });

  it('has the 18 Sep 2024 Bajaj Housing day right: 100 intraday at -Rs 750, 200 delivery from the 17 Sep buy', async () => {
    await withVault(async ({ db, service }) => {
      await importDhan(service);
      recompute(db, DHAN);
      const lots = db
        .prepare(
          `SELECT p.bucket, l.quantity, l.entry_date_ist AS buy, l.exit_value_micro - l.entry_value_micro AS gross
           FROM lot l JOIN position p ON p.id = l.position_id
           WHERE p.instrument_key = 'INE377Y01014' AND l.exit_date_ist = '2024-09-18' ORDER BY p.bucket`,
        )
        .all();
      expect(lots).toEqual([
        { bucket: 'DELIVERY', quantity: 200n, buy: '2024-09-17', gross: -390_000_000n },
        { bucket: 'INTRADAY', quantity: 100n, buy: '2024-09-18', gross: -750_000_000n },
      ]);
    });
  });
});

describe('golden: Zerodha tradebook', () => {
  it('has exactly 10 INCOMPLETE positions, all from the 2025-09-12 orphan sells', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      expect(recompute(db, ZERODHA).incomplete).toBe(10);
      const opened = db
        .prepare(
          'SELECT DISTINCT substr(opened_at_utc, 1, 10) FROM position WHERE account_id = ? AND incomplete = 1',
        )
        .pluck()
        .all(ZERODHA);
      expect(opened).toEqual(['2025-09-12']);
      // No buy precedes those sells in the file: every incomplete position has no lots.
      expect(
        db
          .prepare(
            'SELECT count(*) FROM lot l JOIN position p ON p.id = l.position_id WHERE p.incomplete = 1',
          )
          .pluck()
          .get(),
      ).toBe(0n);
    });
  });

  it('puts exactly the three same-day round trips (ARIHANTCAP, ARSSBL, ADVENTHTL) in INTRADAY', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      recompute(db, ZERODHA);
      const symbols = db
        .prepare(
          `SELECT DISTINCT t.broker_symbol FROM position p
           JOIN lot l ON l.position_id = p.id JOIN fill_allocation f ON f.id = l.entry_allocation_id
           JOIN trade_row t ON t.id = f.trade_row_id
           WHERE p.account_id = ? AND p.bucket = 'INTRADAY' ORDER BY 1`,
        )
        .pluck()
        .all(ZERODHA);
      expect(symbols).toEqual(['ADVENTHTL', 'ARIHANTCAP', 'ARSSBL']);
      expect(
        db
          .prepare('SELECT count(*) FROM fill_allocation WHERE account_id = ? AND inferred = 0')
          .pluck()
          .get(ZERODHA),
      ).toBe(0n);
    });
  });

  it('makes one position for each of the 5 symbols bought on NSE and sold on BSE', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      recompute(db, ZERODHA);
      const rows = db
        .prepare(
          `SELECT t.isin, (SELECT count(*) FROM position p WHERE p.account_id = t.account_id AND p.instrument_key = t.isin) AS positions
           FROM trade_row t WHERE t.account_id = ? GROUP BY t.isin HAVING count(DISTINCT t.exchange) > 1`,
        )
        .all(ZERODHA) as { isin: string; positions: bigint }[];
      expect(rows).toHaveLength(5);
      expect(rows.every((row) => row.positions === 1n)).toBe(true);
    });
  });
});
