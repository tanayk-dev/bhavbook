// Schema invariants for 0001_init (ADR-0003 STRICT + micro-rupees, ADR-0019 no personal identifiers).
import { describe, expect, it } from 'vitest';
import { insertTrade, migratedMemoryDb, seedAccount } from './helpers.js';

interface SchemaRow {
  name: string;
  sql: string;
}

function tables(): SchemaRow[] {
  const db = migratedMemoryDb();
  return db
    .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as SchemaRow[];
}

describe('0001_init schema', () => {
  it('declares every table STRICT', () => {
    const all = tables();
    expect(all.length).toBeGreaterThan(15);
    for (const table of all) expect(table.sql, table.name).toMatch(/\)\s*STRICT(\s*,\s*WITHOUT ROWID)?\s*$/i);
  });

  it('types every *_micro column as INTEGER', () => {
    const db = migratedMemoryDb();
    for (const { name } of tables()) {
      const columns = db.prepare(`SELECT name, type FROM pragma_table_info(?)`).all(name) as {
        name: string;
        type: string;
      }[];
      for (const column of columns.filter((c) => c.name.endsWith('_micro'))) {
        expect(column.type, `${name}.${column.name}`).toBe('INTEGER');
      }
    }
  });

  it('has no column that could hold a personal identifier or an original file name (ADR-0019)', () => {
    const db = migratedMemoryDb();
    const forbidden =
      /^(client_id|client_code|ucc|pan|pan_number|email|mobile|phone|full_name|person_name|file_name|filename|original_name|path)$/;
    for (const { name } of tables()) {
      const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(name) as { name: string }[];
      for (const column of columns) expect(column.name, `${name}.${column.name}`).not.toMatch(forbidden);
    }
  });

  it('rejects a float in a money column', () => {
    const db = migratedMemoryDb();
    seedAccount(db);
    expect(() => {
      insertTrade(db, { price_micro: 700.6 });
    }).toThrow(/cannot store REAL/i);
  });

  it('round-trips money beyond 2^53 exactly as bigint', () => {
    const db = migratedMemoryDb();
    seedAccount(db);
    const huge = 9_007_199_254_740_993_123n;
    insertTrade(db, { trade_value_micro: huge });
    const row = db.prepare('SELECT trade_value_micro FROM trade_row').get() as { trade_value_micro: bigint };
    expect(row.trade_value_micro).toBe(huge);
  });

  it('enforces one row per (account, dedup_key)', () => {
    const db = migratedMemoryDb();
    seedAccount(db);
    insertTrade(db);
    expect(() => {
      insertTrade(db);
    }).toThrow(/UNIQUE/);
  });

  it('enforces foreign keys', () => {
    const db = migratedMemoryDb();
    expect(() =>
      db
        .prepare(
          "INSERT INTO broker_account (id, profile_id, broker, nickname, created_at) VALUES ('a', 'missing', 'dhan', 'x', 'now')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('cascades an import batch deletion to its rows (undo import)', () => {
    const db = migratedMemoryDb();
    seedAccount(db);
    insertTrade(db);
    db.prepare("DELETE FROM import_batch WHERE id = 'batch1'").run();
    expect(db.prepare('SELECT count(*) AS n FROM trade_row').get()).toEqual({ n: 0n });
  });

  it('limits screenshots to 1 MiB of image/webp', () => {
    const db = migratedMemoryDb();
    seedAccount(db);
    db.prepare(
      `INSERT INTO journal_entry (id, anchor_account_id, anchor_instrument_key, anchor_bucket, anchor_key, status, created_at, updated_at)
       VALUES ('j1', 'acc1', 'INE000000000', 'DELIVERY', 'k1', 'attached', 'now', 'now')`,
    ).run();
    const insert = db.prepare(
      "INSERT INTO attachment (id, journal_entry_id, mime, data, created_at) VALUES (?, 'j1', ?, ?, 'now')",
    );
    expect(() => insert.run('a1', 'image/webp', Buffer.alloc(1024 * 1024))).not.toThrow();
    expect(() => insert.run('a2', 'image/webp', Buffer.alloc(1024 * 1024 + 1))).toThrow(/CHECK/);
    expect(() => insert.run('a3', 'image/png', Buffer.alloc(10))).toThrow(/CHECK/);
  });

  it('constrains enumerations', () => {
    const db = migratedMemoryDb();
    seedAccount(db);
    expect(() => {
      insertTrade(db, { side: 'HOLD' });
    }).toThrow(/CHECK/);
    expect(() => {
      insertTrade(db, { dedup_key: 'k2', quantity: 0n });
    }).toThrow(/CHECK/);
  });
});
