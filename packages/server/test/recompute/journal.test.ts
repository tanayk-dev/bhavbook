// S10c (ADR-0018, PRD §10.1): journal entries anchor to a position's opening fill and are re-attached after every
// recompute to whichever position now contains that fill. A recompute never deletes an entry: a lost anchor parks
// it as unattached (with an issue), and two entries on one position raise a collision issue.
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { recompute } from '../../src/recompute/index.js';
import { importFiles, withVault, ZERODHA, type TestVault } from '../import/helpers.js';

const now = (): Date => new Date('2026-10-21T12:00:00Z');
const HEADER =
  'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';
const TCS = 'INE467B01029';

let trade = 0;
function line(side: 'buy' | 'sell', qty: number, price: number, date: string): string {
  trade += 1;
  return `TCS,${TCS},${date},NSE,EQ,EQ,${side},false,${String(qty)},${String(price)},${String(trade)},${String(trade)},${date}T10:00:00`;
}

/** Imports one file of trade lines and returns its batch id. */
async function importLines(db: Database.Database, service: TestVault['service'], lines: readonly string[]) {
  await importFiles(service, ZERODHA, [{ bytes: Buffer.from([HEADER, ...lines].join('\r\n')) }]);
  return db.prepare('SELECT id FROM import_batch ORDER BY rowid DESC LIMIT 1').pluck().get() as string;
}

/** A journal entry on the position whose opening fill happened on `date`. */
function journal(db: Database.Database, id: string, date: string): void {
  const anchor = db
    .prepare('SELECT anchor_key FROM position WHERE opened_at_utc LIKE ?')
    .pluck()
    .get(`${date}%`) as string | undefined;
  if (anchor === undefined) throw new Error(`no position opened on ${date}`);
  db.prepare(
    `INSERT INTO journal_entry (id, anchor_account_id, anchor_instrument_key, anchor_bucket, anchor_key, status,
       created_at, updated_at) VALUES (?, ?, ?, 'DELIVERY', ?, 'attached', 'x', 'x')`,
  ).run(id, ZERODHA, TCS, anchor);
}

interface Attachment {
  readonly id: string;
  readonly status: string;
  readonly position: string | null;
}

function attachments(db: Database.Database): Attachment[] {
  return db
    .prepare(
      `SELECT e.id, e.status, p.opened_at_utc AS position FROM journal_entry e
       LEFT JOIN journal_attachment a ON a.journal_entry_id = e.id LEFT JOIN position p ON p.id = a.position_id
       ORDER BY e.id`,
    )
    .all() as Attachment[];
}

function issues(db: Database.Database, kind: string): { status: string; subject: unknown }[] {
  const rows = db
    .prepare('SELECT status, subject_json FROM issue WHERE kind = ? ORDER BY fingerprint')
    .all(kind) as { status: string; subject_json: string }[];
  return rows.map((row) => ({ status: row.status, subject: JSON.parse(row.subject_json) as unknown }));
}

describe('journal anchors', () => {
  it('an entry follows its fill when older history merges its INCOMPLETE position into a complete one', async () => {
    await withVault(async ({ db, service }) => {
      await importLines(db, service, [line('sell', 10, 110, '2025-04-01')]);
      expect(recompute(db, ZERODHA, { now }).incomplete).toBe(1);
      journal(db, 'j1', '2025-04-01');
      recompute(db, ZERODHA, { now });
      expect(attachments(db)).toEqual([{ id: 'j1', status: 'attached', position: '2025-04-01T04:30:00Z' }]);

      await importLines(db, service, [line('buy', 10, 100, '2025-01-02')]);
      const summary = recompute(db, ZERODHA, { now });
      expect([summary.positions, summary.incomplete]).toEqual([1, 0]);
      // The position now opens with the older buy, and still contains the entry's fill.
      expect(attachments(db)).toEqual([{ id: 'j1', status: 'attached', position: '2025-01-02T04:30:00Z' }]);
      expect(issues(db, 'journal_unattached')).toEqual([]);
    });
  });

  it('undoing the import with the anchor fill parks the entry; re-importing it attaches it again', async () => {
    await withVault(async ({ db, service }) => {
      const opening = line('buy', 10, 100, '2025-01-02');
      const first = await importLines(db, service, [opening]);
      await importLines(db, service, [
        line('buy', 5, 120, '2025-06-02'),
        line('sell', 15, 130, '2025-07-01'),
      ]);
      recompute(db, ZERODHA, { now });
      journal(db, 'j1', '2025-01-02');
      const anchor = db.prepare("SELECT anchor_key FROM journal_entry WHERE id = 'j1'").pluck().get();

      // Undo the first import: the position now opens with the June buy, and the anchor fill is gone.
      service.undoImport(first);
      recompute(db, ZERODHA, { now });
      expect(attachments(db)).toEqual([{ id: 'j1', status: 'unattached', position: null }]);
      expect(issues(db, 'journal_unattached')).toEqual([
        { status: 'open', subject: { journalEntryId: 'j1', instrumentKey: TCS, bucket: 'DELIVERY' } },
      ]);
      expect(db.prepare('SELECT count(*) FROM journal_entry').pluck().get()).toBe(1n);

      // The same fill again: the anchor is back.
      await importLines(db, service, [opening]);
      recompute(db, ZERODHA, { now });
      expect(db.prepare("SELECT anchor_key FROM journal_entry WHERE id = 'j1'").pluck().get()).toBe(anchor);
      expect(attachments(db)).toEqual([{ id: 'j1', status: 'attached', position: '2025-01-02T04:30:00Z' }]);
      expect(issues(db, 'journal_unattached').map((issue) => issue.status)).toEqual(['resolved']);
    });
  });

  it('two entries that land on one position raise a collision issue, and keep both', async () => {
    await withVault(async ({ db, service }) => {
      await importLines(db, service, [
        line('sell', 10, 110, '2025-04-01'),
        line('buy', 10, 120, '2025-05-01'),
        line('sell', 10, 130, '2025-05-02'),
      ]);
      recompute(db, ZERODHA, { now });
      journal(db, 'j1', '2025-04-01');
      journal(db, 'j2', '2025-05-01');
      recompute(db, ZERODHA, { now });
      expect(issues(db, 'journal_collision')).toEqual([]);

      await importLines(db, service, [line('buy', 20, 100, '2025-01-02')]);
      recompute(db, ZERODHA, { now });
      expect(attachments(db)).toEqual([
        { id: 'j1', status: 'attached', position: '2025-01-02T04:30:00Z' },
        { id: 'j2', status: 'attached', position: '2025-01-02T04:30:00Z' },
      ]);
      const [collision] = issues(db, 'journal_collision');
      expect(collision?.status).toBe('open');
      expect(collision?.subject).toMatchObject({ journalEntryIds: ['j1', 'j2'] });
    });
  });

  it('a recompute rebuilds attachments without touching the entries themselves', async () => {
    await withVault(async ({ db, service }) => {
      await importLines(db, service, [line('buy', 10, 100, '2025-01-02')]);
      recompute(db, ZERODHA, { now });
      journal(db, 'j1', '2025-01-02');
      db.prepare(
        "UPDATE journal_entry SET thesis = 'Breakout above 4,000', updated_at = 'then' WHERE id = 'j1'",
      ).run();
      recompute(db, ZERODHA, { now });
      recompute(db, ZERODHA, { now });
      expect(
        db.prepare("SELECT thesis, updated_at, status FROM journal_entry WHERE id = 'j1'").get(),
      ).toEqual({ thesis: 'Breakout above 4,000', updated_at: 'then', status: 'attached' });
      expect(db.prepare('SELECT count(*) FROM journal_attachment').pluck().get()).toBe(1n);
    });
  });
});
