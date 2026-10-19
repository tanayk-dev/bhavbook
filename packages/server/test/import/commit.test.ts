// commitImport: one transaction per commit, idempotent (PRD §3.2 invariant 4), nothing personal stored (ADR-0019).
import { readdirSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ImportError } from '../../src/import/index.js';
import { backupDir, currentVersion, latestVersion } from '../../src/vault/index.js';
import {
  count,
  csvWindow,
  DHAN,
  dhanDays,
  fixtureFile,
  importFiles,
  tradeSet,
  withVault,
  ZERODHA,
} from './helpers.js';

describe('commitImport', () => {
  it('writes the batch, raw rows, trade rows and per-batch copies in one go', async () => {
    await withVault(async ({ db, service }) => {
      const preview = await service.previewImport(ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      const result = service.commitImport(preview.token ?? '');
      expect(result.batches).toEqual([
        { batchId: expect.any(String) as string, kind: 'zerodha.tradebook', inserted: { rows: 121, statements: 0 } },
      ]);
      expect(count(db, 'import_batch')).toBe(1);
      expect(count(db, 'raw_row')).toBe(121);
      expect(count(db, 'trade_row', `account_id = '${ZERODHA}'`)).toBe(121);
      expect(count(db, 'trade_row', 'raw_row_id IS NULL')).toBe(0);
      expect(count(db, 'batch_row')).toBe(121);
      const batch = db.prepare('SELECT * FROM import_batch').get() as Record<string, unknown>;
      expect(batch).toMatchObject({
        account_id: ZERODHA,
        report_kind: 'zerodha.tradebook',
        adapter_version: '1',
        coverage_from: '2025-09-12',
        coverage_to: '2026-03-23',
        status: 'committed',
      });
      expect(batch.file_sha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('takes a pre-import backup and notifies the recompute hook', async () => {
    const changed: string[] = [];
    await withVault(
      async ({ vaultPath, service }) => {
        await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
        expect(readdirSync(backupDir(vaultPath)).filter((name) => name.includes('pre-import'))).toHaveLength(1);
        expect(changed).toEqual([ZERODHA]);
      },
      { onChanged: (accountId) => changed.push(accountId) },
    );
  });

  it('re-importing the same file adds 0 rows (but records the batch)', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      const before = tradeSet(db, ZERODHA);
      const preview = await service.previewImport(ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      expect(preview.files[0]).toMatchObject({ counts: { rows: { new: 0, duplicate: 121 } } });
      expect(service.commitImport(preview.token ?? '').batches[0]?.inserted).toEqual({ rows: 0, statements: 0 });
      expect(tradeSet(db, ZERODHA)).toEqual(before);
      expect(count(db, 'import_batch')).toBe(2);
      expect(count(db, 'batch_row')).toBe(242);
    });
  });

  it('deduplicates overlapping Zerodha windows', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [csvWindow('zerodha', 'tradebook', 0, 80)]);
      await importFiles(service, ZERODHA, [csvWindow('zerodha', 'tradebook', 40, 121)]);
      expect(count(db, 'trade_row')).toBe(121);
    });
  });

  it('deduplicates overlapping whole-day Dhan files', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, DHAN, [dhanDays((day) => day <= '2025-06-30')]);
      await importFiles(service, DHAN, [dhanDays((day) => day >= '2024-12-01')]);
      expect(count(db, 'trade_row')).toBe(116);
    });
  });

  it('imports statements idempotently (Zerodha tax P&L, Dhan Global Transactions)', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tax_pnl', 'tax.xlsx')]);
      await importFiles(service, DHAN, [fixtureFile('dhan', 'global_transactions')]);
      const statements = count(db, 'statement_row');
      expect(count(db, 'statement_row', `account_id = '${DHAN}' AND kind = 'dhan.gt.row'`)).toBe(80);
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tax_pnl', 'tax.xlsx')]);
      await importFiles(service, DHAN, [fixtureFile('dhan', 'global_transactions')]);
      expect(count(db, 'statement_row')).toBe(statements);
      const row = db.prepare("SELECT data_json FROM statement_row WHERE kind = 'dhan.gt.row' LIMIT 1").get() as {
        data_json: string;
      };
      expect(JSON.parse(row.data_json)).toMatchObject({ buy_value_micro: expect.stringMatching(/^-?\d+$/) as string });
    });
  });

  it('stores no original file name anywhere', async () => {
    await withVault(async ({ db, service }) => {
      const name = 'SECRETNAME-XY1234-tradebook.csv';
      await importFiles(service, ZERODHA, [{ ...fixtureFile('zerodha', 'tradebook'), name }]);
      await importFiles(service, DHAN, [{ ...fixtureFile('dhan', 'trade_history'), name }]);
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[];
      for (const { name: table } of tables) {
        const columns = db.prepare(`SELECT name, type FROM pragma_table_info(?)`).all(table) as {
          name: string;
          type: string;
        }[];
        for (const column of columns.filter((entry) => entry.type === 'TEXT')) {
          const hits = db
            .prepare(`SELECT count(*) AS n FROM "${table}" WHERE instr("${column.name}", ?) > 0`)
            .get('SECRETNAME') as { n: bigint };
          expect(`${table}.${column.name}: ${String(hits.n)}`).toBe(`${table}.${column.name}: 0`);
        }
      }
    });
  });

  it('is atomic: a failure mid-commit leaves nothing behind', async () => {
    await withVault(async ({ db, service }) => {
      const preview = await service.previewImport(ZERODHA, [
        fixtureFile('zerodha', 'tradebook'),
        fixtureFile('zerodha', 'tax_pnl', 'tax.xlsx'),
      ]);
      // A trigger that fails the second file's first statement insert.
      db.exec(
        "CREATE TEMP TRIGGER boom BEFORE INSERT ON main.statement_row BEGIN SELECT RAISE(ABORT, 'boom'); END;",
      );
      expect(() => service.commitImport(preview.token ?? '')).toThrow(ImportError);
      db.exec('DROP TRIGGER temp.boom');
      for (const table of ['import_batch', 'raw_row', 'trade_row', 'statement_row', 'batch_row']) {
        expect(count(db, table)).toBe(0);
      }
    });
  });

  it('runs on a vault migrated forward from schema 1', async () => {
    await withVault(({ db }) => {
      expect(currentVersion(db)).toBe(latestVersion());
      expect(latestVersion()).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('wrong-account guard (PRD §6.4)', () => {
  it('warns when a file overlaps the covered range but shares under 10% of its keys there', async () => {
    await withVault(async ({ service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      // Same days, different trades: another person's tradebook.
      const other = fixtureFile('zerodha', 'tradebook');
      const text = other.bytes
        .toString('utf8')
        .replace(/,(\d{9}),(\d{16}),/g, (_match, trade: string, order: string) => `,9${trade.slice(1)},9${order.slice(1)},`);
      const preview = await service.previewImport(ZERODHA, [{ bytes: Buffer.from(text) }]);
      expect(preview.files[0]).toMatchObject({ status: 'ready', warnings: ['wrong_account'] });
    });
  });

  it('does not warn for an overlapping window of the same account, or for a new range', async () => {
    await withVault(async ({ service }) => {
      await importFiles(service, ZERODHA, [csvWindow('zerodha', 'tradebook', 0, 80)]);
      const preview = await service.previewImport(ZERODHA, [
        csvWindow('zerodha', 'tradebook', 40, 121),
        csvWindow('zerodha', 'tradebook', 100, 121),
      ]);
      expect(preview.files.map((file) => (file.status === 'ready' ? file.warnings : null))).toEqual([[], []]);
    });
  });
});

describe('idempotency property (PRD §3.2 invariant 4)', () => {
  const WINDOWS = [
    csvWindow('zerodha', 'tradebook', 0, 50),
    csvWindow('zerodha', 'tradebook', 30, 90),
    csvWindow('zerodha', 'tradebook', 70, 121),
    csvWindow('zerodha', 'tradebook', 0, 121),
    csvWindow('zerodha', 'tradebook', 10, 20),
  ];

  /** The account's rows after committing each group of windows as one import, in order. */
  async function finalRows(groups: readonly (readonly number[])[]): Promise<string[]> {
    let rows: string[] = [];
    await withVault(async ({ db, service }) => {
      for (const group of groups) {
        await importFiles(
          service,
          ZERODHA,
          group.map((index) => WINDOWS[index] ?? WINDOWS[0] ?? fixtureFile('zerodha', 'tradebook')),
        );
      }
      rows = tradeSet(db, ZERODHA);
    });
    return rows;
  }

  it('any subset of files, in any order and grouping, gives the same final rows', async () => {
    const index = fc.integer({ min: 0, max: WINDOWS.length - 1 });
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(index, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 4 }),
        async (groups) => {
          const canonical = [...new Set(groups.flat())].sort((a, b) => a - b);
          expect(await finalRows(groups)).toEqual(await finalRows([canonical]));
        },
      ),
      { numRuns: 20 },
    );
  }, 180_000);
});

describe('benchmark', () => {
  it('commits 5,000 rows in under 5 s', async () => {
    const header =
      'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';
    const rows = Array.from({ length: 5_000 }, (_unused, index) => {
      const day = String((index % 28) + 1).padStart(2, '0');
      return `TCS,INE467B01029,2025-09-${day},NSE,EQ,EQ,${index % 2 ? 'sell' : 'buy'},false,1,3130.600098,${String(700_000_000 + index)},${String(1_300_000_000_000_000 + index)},2025-09-${day}T10:00:00`;
    });
    const file = { bytes: Buffer.from([header, ...rows].join('\r\n')) };
    await withVault(async ({ db, service }) => {
      const started = performance.now();
      await importFiles(service, ZERODHA, [file]);
      const ms = performance.now() - started;
      expect(count(db, 'trade_row')).toBe(5_000);
      if (ms >= 5_000) {
        const message = `import benchmark: 5,000 rows took ${ms.toFixed(0)} ms (budget 5,000 ms)`;
        if (process.env.BENCH === '1') throw new Error(message);
        console.warn(message);
      }
    });
  }, 60_000);
});

