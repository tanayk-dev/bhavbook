// undoImport (PRD §5.1): delete exactly one batch's rows; rows another batch shares survive under the earliest
// surviving batch that contains them (plan r5, schema 0002).
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import fc from 'fast-check';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ImportError, type ImportFile } from '../../src/import/index.js';
import { backupDir } from '../../src/vault/index.js';
import { count, csvWindow, DHAN, fixtureFile, importFiles, tradeSet, withVault, ZERODHA } from './helpers.js';

/** A hash of every row of every table: undo must restore the earlier state exactly. */
function tablesHash(db: Database.Database): string {
  const hash = createHash('sha256');
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck()
    .all() as string[];
  for (const table of tables) {
    hash.update(table);
    const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all();
    hash.update(JSON.stringify(rows, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)));
  }
  return hash.digest('hex');
}

function batchIds(db: Database.Database): string[] {
  return db.prepare('SELECT id FROM import_batch ORDER BY rowid').pluck().all() as string[];
}

function ownerOf(db: Database.Database, dedupKey: string): string {
  return db.prepare('SELECT batch_id FROM trade_row WHERE dedup_key = ?').pluck().get(dedupKey) as string;
}

describe('undoImport', () => {
  it('restores the state before the batch (table hash)', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [csvWindow('zerodha', 'tradebook', 0, 60)]);
      const before = tablesHash(db);
      await importFiles(service, ZERODHA, [csvWindow('zerodha', 'tradebook', 60, 121)]);
      const [, second] = batchIds(db);
      service.undoImport(second ?? '');
      expect(tablesHash(db)).toBe(before);
    });
  });

  it('keeps rows a later overlapping batch shares when the earlier one is undone', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [csvWindow('zerodha', 'tradebook', 0, 80)]);
      await importFiles(service, ZERODHA, [csvWindow('zerodha', 'tradebook', 40, 121)]);
      const [first, second] = batchIds(db);
      service.undoImport(first ?? '');
      expect(count(db, 'trade_row')).toBe(81);
      expect(count(db, 'trade_row', `batch_id <> '${second ?? ''}'`)).toBe(0);
      // Every surviving row points at the surviving batch's own raw row, with the same raw text.
      expect(
        count(
          db,
          'trade_row t',
          `NOT EXISTS (SELECT 1 FROM raw_row r WHERE r.id = t.raw_row_id AND r.batch_id = t.batch_id)`,
        ),
      ).toBe(0);
      let alone: string[] = [];
      await withVault(async (fresh) => {
        await importFiles(fresh.service, ZERODHA, [csvWindow('zerodha', 'tradebook', 40, 121)]);
        alone = tradeSet(fresh.db, ZERODHA);
      });
      expect(tradeSet(db, ZERODHA)).toEqual(alone);
    });
  });

  it('hands shared rows to the earliest surviving batch', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [csvWindow('zerodha', 'tradebook', 0, 60)]);
      await importFiles(service, ZERODHA, [csvWindow('zerodha', 'tradebook', 30, 90)]);
      await importFiles(service, ZERODHA, [csvWindow('zerodha', 'tradebook', 50, 121)]);
      const [first, second, third] = batchIds(db);
      const shared = db
        .prepare('SELECT dedup_key FROM batch_row WHERE batch_id = ? AND target = ? ORDER BY id LIMIT 1 OFFSET 25')
        .pluck()
        .get(third ?? '', 'trade') as string;
      service.undoImport(first ?? '');
      expect(ownerOf(db, shared)).toBe(second);
      service.undoImport(second ?? '');
      expect(ownerOf(db, shared)).toBe(third);
      expect(count(db, 'trade_row')).toBe(71);
    });
  });

  it('keeps shared statements too, with identical data', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, DHAN, [fixtureFile('dhan', 'global_transactions')]);
      const data = db.prepare('SELECT data_json FROM statement_row ORDER BY dedup_key').pluck().all();
      await importFiles(service, DHAN, [fixtureFile('dhan', 'global_transactions')]);
      const [first, second] = batchIds(db);
      service.undoImport(first ?? '');
      expect(count(db, 'statement_row', `batch_id = '${second ?? ''}'`)).toBe(80);
      expect(db.prepare('SELECT data_json FROM statement_row ORDER BY dedup_key').pluck().all()).toEqual(data);
    });
  });

  it('undoing every batch empties the import tables', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tax_pnl', 'tax.xlsx')]);
      for (const id of batchIds(db)) service.undoImport(id);
      for (const table of ['import_batch', 'raw_row', 'trade_row', 'statement_row', 'batch_row']) {
        expect(count(db, table)).toBe(0);
      }
    });
  });

  it('takes a pre-undo backup, notifies the recompute hook and rejects unknown batches', async () => {
    const changed: string[] = [];
    await withVault(
      async ({ db, vaultPath, service }) => {
        await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
        const [batch] = batchIds(db);
        expect(service.undoImport(batch ?? '')).toEqual({ accountId: ZERODHA, removed: { rows: 121, statements: 0 } });
        expect(readdirSync(backupDir(vaultPath)).filter((name) => name.includes('pre-undo'))).toHaveLength(1);
        expect(changed).toEqual([ZERODHA, ZERODHA]);
        expect(() => service.undoImport(batch ?? '')).toThrow(ImportError);
      },
      { onChanged: (accountId) => changed.push(accountId) },
    );
  });
});

describe('import/undo property (PRD §3.2 invariants 3 and 4)', () => {
  const WINDOWS: readonly ImportFile[] = [
    csvWindow('zerodha', 'tradebook', 0, 50),
    csvWindow('zerodha', 'tradebook', 30, 90),
    csvWindow('zerodha', 'tradebook', 70, 121),
    csvWindow('zerodha', 'tradebook', 10, 20),
  ];

  function window(index: number): ImportFile {
    const file = WINDOWS[index];
    if (file === undefined) throw new Error(`no window ${String(index)}`);
    return file;
  }

  it('after any imports and undos, the rows equal importing the surviving files in order', async () => {
    const step = fc.oneof(
      fc.record({ op: fc.constant('import' as const), index: fc.integer({ min: 0, max: WINDOWS.length - 1 }) }),
      fc.record({ op: fc.constant('undo' as const), pick: fc.nat() }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 8 }), async (steps) => {
        let actual: string[] = [];
        let surviving: number[] = [];
        await withVault(async ({ db, service }) => {
          const batches: { id: string; index: number }[] = [];
          for (const entry of steps) {
            if (entry.op === 'import') {
              await importFiles(service, ZERODHA, [window(entry.index)]);
              batches.push({ id: batchIds(db).at(-1) ?? '', index: entry.index });
            } else if (batches.length > 0) {
              const [victim] = batches.splice(entry.pick % batches.length, 1);
              service.undoImport(victim?.id ?? '');
            }
          }
          actual = tradeSet(db, ZERODHA);
          surviving = batches.map((batch) => batch.index);
        });
        let expected: string[] = [];
        await withVault(async ({ db, service }) => {
          for (const index of surviving) await importFiles(service, ZERODHA, [window(index)]);
          expected = tradeSet(db, ZERODHA);
        });
        expect(actual).toEqual(expected);
      }),
      { numRuns: 20 },
    );
  }, 240_000);
});
