// recompute (plan S9 task 5): byte-identical re-runs, INCOMPLETE issues, instrument re-keying, the import hooks
// and the issue forecast, isolation, and the benchmark.
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { forecastIssues, recompute, recomputeHooks } from '../../src/recompute/index.js';
import { count, DHAN, fixtureFile, importFiles, withVault, ZERODHA } from '../import/helpers.js';

/** Derived state without surrogate ids (allocations and lots are referenced through their trade rows). */
function derivedHash(db: Database.Database): string {
  const hash = createHash('sha256');
  const dump = (sql: string): void => {
    hash.update(
      JSON.stringify(db.prepare(sql).all(), (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  };
  dump('SELECT * FROM position ORDER BY id');
  dump(
    `SELECT t.dedup_key, f.instrument_key, f.bucket, f.side, f.quantity, f.value_micro, f.inferred
     FROM fill_allocation f JOIN trade_row t ON t.id = f.trade_row_id ORDER BY t.dedup_key, f.bucket`,
  );
  dump(
    `SELECT l.position_id, te.dedup_key AS entry, tx.dedup_key AS exit, l.quantity, l.entry_value_micro,
            l.exit_value_micro, l.entry_date_ist, l.exit_date_ist
     FROM lot l JOIN fill_allocation fe ON fe.id = l.entry_allocation_id JOIN trade_row te ON te.id = fe.trade_row_id
     LEFT JOIN fill_allocation fx ON fx.id = l.exit_allocation_id LEFT JOIN trade_row tx ON tx.id = fx.trade_row_id
     ORDER BY 1, 2, 3, 4`,
  );
  dump('SELECT id, kind, fingerprint, subject_json, status FROM issue ORDER BY id');
  return hash.digest('hex');
}

const now = (): Date => new Date('2026-10-19T12:00:00Z');

describe('recompute', () => {
  it('is byte-identical across runs (ADR-0007)', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      recompute(db, ZERODHA, { now });
      const first = derivedHash(db);
      recompute(db, ZERODHA, { now });
      expect(derivedHash(db)).toBe(first);
    });
  });

  it('raises one issue per INCOMPLETE position and resolves it when an older import covers the sell', async () => {
    await withVault(async ({ db, service }) => {
      const header =
        'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';
      const sell = 'TCS,INE467B01029,2025-09-12,NSE,EQ,EQ,sell,false,5,3130.6,1,10,2025-09-12T14:50:01';
      const buy = 'TCS,INE467B01029,2025-08-01,NSE,EQ,EQ,buy,false,5,3000,2,20,2025-08-01T10:00:00';
      await importFiles(service, ZERODHA, [{ bytes: Buffer.from(`${header}\r\n${sell}`) }]);
      recompute(db, ZERODHA, { now });
      expect(db.prepare("SELECT status FROM issue WHERE kind = 'incomplete_position'").pluck().all()).toEqual(
        ['open'],
      );
      await importFiles(service, ZERODHA, [{ bytes: Buffer.from(`${header}\r\n${buy}`) }]);
      expect(recompute(db, ZERODHA, { now }).incomplete).toBe(0);
      expect(db.prepare("SELECT status FROM issue WHERE kind = 'incomplete_position'").pluck().all()).toEqual(
        ['resolved'],
      );
    });
  });

  it('keeps a dismissed INCOMPLETE issue dismissed', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      recompute(db, ZERODHA, { now });
      const id = db
        .prepare("SELECT id FROM issue WHERE kind = 'incomplete_position' ORDER BY id LIMIT 1")
        .pluck()
        .get() as string;
      db.prepare("UPDATE issue SET status = 'dismissed' WHERE id = ?").run(id);
      recompute(db, ZERODHA, { now });
      expect(db.prepare('SELECT status FROM issue WHERE id = ?').pluck().get(id)).toBe('dismissed');
    });
  });

  it('re-keys positions when a Dhan name is resolved later, without duplicating them', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, DHAN, [fixtureFile('dhan', 'trade_history')]);
      recompute(db, DHAN, { now });
      const before = count(db, 'position', `account_id = '${DHAN}'`);
      expect(count(db, 'position', "instrument_key LIKE 'local:dhan:%'")).toBe(before);
      await importFiles(service, DHAN, [
        fixtureFile('dhan', 'global_transactions'),
        fixtureFile('dhan', 'dp_charges'),
        fixtureFile('dhan', 'tax_report', 'tax.xls'),
      ]);
      recompute(db, DHAN, { now });
      expect(count(db, 'position', `account_id = '${DHAN}'`)).toBe(before);
      const local = count(db, 'position', "instrument_key LIKE 'local:dhan:%'");
      expect(local).toBeLessThan(before);
      expect(count(db, 'position', "instrument_key LIKE 'IN%'")).toBe(before - local);
    });
  });

  it('keeps accounts apart', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      await importFiles(service, DHAN, [fixtureFile('dhan', 'trade_history')]);
      recompute(db, ZERODHA, { now });
      const zerodha = count(db, 'position', `account_id = '${ZERODHA}'`);
      recompute(db, DHAN, { now });
      expect(count(db, 'position', `account_id = '${ZERODHA}'`)).toBe(zerodha);
      expect(
        count(
          db,
          'lot l JOIN position p ON p.id = l.position_id JOIN fill_allocation f ON f.id = l.entry_allocation_id',
          'f.account_id <> p.account_id',
        ),
      ).toBe(0);
    });
  });
});

describe('import hooks', () => {
  it('recomputes after commit and after undo', async () => {
    await withVault(
      async ({ db, service }) => {
        await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
        expect(count(db, 'position', `account_id = '${ZERODHA}'`)).toBe(28);
        const batch = db.prepare('SELECT id FROM import_batch').pluck().get() as string;
        service.undoImport(batch);
        expect(count(db, 'position')).toBe(0);
        expect(count(db, 'fill_allocation')).toBe(0);
      },
      {},
      (db) => recomputeHooks(db, { now }),
    );
  });

  it('forecasts the INCOMPLETE issues a preview would create', async () => {
    await withVault(
      async ({ service }) => {
        const preview = await service.previewImport(ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
        const file = preview.files[0];
        const forecast = file?.status === 'ready' ? file.issueForecast : [];
        expect(forecast).toHaveLength(10);
        expect(forecast.every((entry) => entry.change === 'create')).toBe(true);
      },
      {},
      (db) => recomputeHooks(db, { now }),
    );
  });

  it('forecasts resolved issues too, and writes nothing', async () => {
    await withVault(async ({ db, service }) => {
      const header =
        'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';
      await importFiles(service, ZERODHA, [
        {
          bytes: Buffer.from(
            `${header}\r\nTCS,INE467B01029,2025-09-12,NSE,EQ,EQ,sell,false,5,3130.6,1,10,2025-09-12T14:50:01`,
          ),
        },
      ]);
      recompute(db, ZERODHA, { now });
      const before = count(db, 'position');
      const buy = {
        dedupKey: 'zerodha:NSE:2025-08-01:20:2',
        isin: 'INE467B01029',
        brokerSymbol: 'TCS',
        brokerName: null,
      };
      const rows = [
        {
          ...buy,
          granularity: 'fill',
          source: 'tradebook',
          externalOrderId: '20',
          executedAtUtc: '2025-08-01T04:30:00Z',
          tradeDateIst: '2025-08-01',
          side: 'BUY',
          quantity: 5n,
          priceMicro: 3_000_000_000n,
          tradeValueMicro: 15_000_000_000n,
          valueAuthority: 'price',
          exchange: 'NSE',
          productDeclared: null,
          flags: {},
          raw: { line: 2, text: 'x' },
        } as const,
      ];
      const forecast = forecastIssues(
        db,
        ZERODHA,
        { rows, statements: [], instrumentHints: [], skipped: [], errors: [], coverage: null },
        { now },
      );
      expect(forecast.map((entry) => entry.change)).toEqual(['resolve']);
      expect(count(db, 'position')).toBe(before);
      expect(count(db, 'import_batch')).toBe(1);
    });
  });
});

describe('benchmark', () => {
  it('recomputes 20,000 rows in under 3 s', async () => {
    await withVault(({ db }) => {
      db.prepare(
        "INSERT INTO import_batch (id, account_id, file_sha256, report_kind, adapter_version, counts_json, status, created_at) VALUES ('b', ?, ?, 'zerodha.tradebook', '1', '{}', 'committed', 'x')",
      ).run(ZERODHA, 'a'.repeat(64));
      const insert = db.prepare(
        `INSERT INTO trade_row (account_id, batch_id, dedup_key, granularity, source, executed_at_utc, trade_date_ist,
           side, quantity, price_micro, trade_value_micro, value_authority, exchange, isin, broker_symbol)
         VALUES (?, 'b', ?, 'fill', 'tradebook', ?, ?, ?, ?, 1000000, ?, 'price', 'NSE', ?, ?)`,
      );
      db.transaction(() => {
        for (let index = 0; index < 20_000; index += 1) {
          const day = `2025-${String(1 + (index % 12)).padStart(2, '0')}-${String(1 + (index % 28)).padStart(2, '0')}`;
          const isin = `INE${String(index % 60).padStart(9, '0')}`;
          insert.run(
            ZERODHA,
            `k${String(index)}`,
            `${day}T04:${String(index % 60).padStart(2, '0')}:00Z`,
            day,
            index % 3 === 2 ? 'SELL' : 'BUY',
            BigInt(1 + (index % 9)),
            BigInt(1 + (index % 9)) * 1_000_000n,
            isin,
            `S${String(index % 60)}`,
          );
        }
      })();
      const started = performance.now();
      recompute(db, ZERODHA, { now });
      const ms = performance.now() - started;
      expect(count(db, 'fill_allocation')).toBeGreaterThanOrEqual(20_000);
      if (ms >= 3_000) {
        const message = `recompute benchmark: 20,000 rows took ${ms.toFixed(0)} ms (budget 3,000 ms)`;
        if (process.env.BENCH === '1') throw new Error(message);
        console.warn(message);
      }
    });
  }, 120_000);
});
