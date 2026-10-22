// S14a-2: journal screenshots and merging colliding entries. Only a well-formed WebP of at most 1 MB with no EXIF or
// XMP chunk is stored; it is served back as image/webp and can be deleted. Merging a collision keeps the chosen
// entry's values, fills its gaps from the other, moves tags and screenshots, and resolves the issue.
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { recompute } from '../../src/recompute/index.js';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_ENTRY,
  webpProblem,
} from '../../src/services/attachments.js';
import { importFiles, withVault, ZERODHA } from '../import/helpers.js';
import { send, testApp, type TestApp } from './helpers.js';

const HEADER =
  'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';
const BUY = 'TCS,INE467B01029,2025-09-12,NSE,EQ,EQ,buy,false,10,100,1,10,2025-09-12T10:00:00';
const SELL = 'TCS,INE467B01029,2025-09-15,NSE,EQ,EQ,sell,false,10,120,2,20,2025-09-15T11:00:00';

/** A 1x1 lossless WebP. */
const PIXEL = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00,
  0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00,
]);

/** A RIFF WebP container of the given chunks (ids and payloads), with correct sizes and padding. */
function webp(chunks: readonly [string, Uint8Array][]): Uint8Array {
  const parts = chunks.map(([id, payload]) => {
    const padded = new Uint8Array(8 + payload.length + (payload.length % 2));
    padded.set(Buffer.from(id, 'latin1'), 0);
    new DataView(padded.buffer).setUint32(4, payload.length, true);
    padded.set(payload, 8);
    return padded;
  });
  const body = Buffer.concat([Buffer.from('WEBP'), ...parts]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return new Uint8Array(Buffer.concat([header, body]));
}

const image = PIXEL.subarray(20);

const upload = (bytes: Uint8Array, type = 'image/webp') => ({
  method: 'POST',
  headers: { 'content-type': type },
  body: bytes,
});

const json = (method: string, value: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

const ENTRY = {
  setupTagId: null,
  mistakeTagIds: [],
  thesis: null,
  initialStopMicro: null,
  plannedStopMicro: null,
  plannedTargetMicro: null,
  plannedRiskMicro: null,
  reviewNote: null,
};

describe('what counts as a screenshot', () => {
  it('accepts a WebP and refuses anything else, metadata or a broken container', () => {
    expect(webpProblem(PIXEL)).toBeNull();
    expect(webpProblem(webp([['VP8L', image.subarray(0, 13)]]))).toBeNull();
    // An odd-sized chunk is padded; the next chunk follows the pad byte.
    expect(
      webpProblem(
        webp([
          ['VP8X', new Uint8Array(9)],
          ['VP8L', image.subarray(0, 13)],
        ]),
      ),
    ).toBeNull();
    expect(
      webpProblem(
        webp([
          ['VP8L', image.subarray(0, 13)],
          ['EXIF', new Uint8Array(4)],
        ]),
      ),
    ).toBe('has_metadata');
    expect(
      webpProblem(
        webp([
          ['XMP ', new Uint8Array(4)],
          ['VP8L', image.subarray(0, 13)],
        ]),
      ),
    ).toBe('has_metadata');
    expect(webpProblem(webp([['ICCP', new Uint8Array(4)]]))).toBe('not_webp');
    expect(webpProblem(Buffer.from('\x89PNG\r\n\x1a\n0000000000000000', 'latin1'))).toBe('not_webp');
    expect(webpProblem(PIXEL.subarray(0, 30))).toBe('not_webp');
    const lying = Uint8Array.from(PIXEL);
    lying[16] = 0x40; // a chunk claiming more bytes than the file has
    expect(webpProblem(lying)).toBe('not_webp');
    expect(webpProblem(new Uint8Array(MAX_ATTACHMENT_BYTES + 1))).toBe('too_large');
    const pixels = image.subarray(0, 13);
    // Exactly 1 MB is allowed.
    const full = webp([['VP8L', new Uint8Array(MAX_ATTACHMENT_BYTES - 20)]]);
    expect(full.length).toBe(MAX_ATTACHMENT_BYTES);
    expect(webpProblem(full)).toBeNull();
    // Only a still image of the chunks a canvas writes.
    expect(webpProblem(webp([['VP8X', new Uint8Array(10)]]))).toBe('not_webp');
    expect(
      webpProblem(
        webp([
          ['VP8L', pixels],
          ['VP8L', pixels],
        ]),
      ),
    ).toBe('not_webp');
    expect(
      webpProblem(
        webp([
          ['VP8L', pixels],
          ['JUNK', Buffer.from('lat=12.97')],
        ]),
      ),
    ).toBe('not_webp');
    expect(
      webpProblem(
        webp([
          ['VP8X', new Uint8Array(10)],
          ['ANIM', new Uint8Array(6)],
          ['VP8L', pixels],
        ]),
      ),
    ).toBe('not_webp');
    expect(
      webpProblem(
        webp([
          ['VP8L', pixels],
          ['VP8X', new Uint8Array(10)],
        ]),
      ),
    ).toBe('not_webp');
    expect(
      webpProblem(
        webp([
          ['VP8X', new Uint8Array(10)],
          ['ICCP', new Uint8Array(8)],
          ['ALPH', new Uint8Array(3)],
          ['VP8 ', new Uint8Array(10)],
        ]),
      ),
    ).toBeNull();
    // A VP8X header that declares metadata or animation.
    expect(
      webpProblem(
        webp([
          ['VP8X', Uint8Array.from([0x08, ...new Uint8Array(9)])],
          ['VP8L', pixels],
        ]),
      ),
    ).toBe('has_metadata');
    expect(
      webpProblem(
        webp([
          ['VP8X', Uint8Array.from([0x04, ...new Uint8Array(9)])],
          ['VP8L', pixels],
        ]),
      ),
    ).toBe('has_metadata');
    expect(
      webpProblem(
        webp([
          ['VP8X', Uint8Array.from([0x02, ...new Uint8Array(9)])],
          ['VP8L', pixels],
        ]),
      ),
    ).toBe('not_webp');
  });
});

async function withEntry(run: (test: TestApp, entryId: string, db: Database.Database) => Promise<void>) {
  await withVault(async (vault) => {
    await importFiles(vault.service, ZERODHA, [{ bytes: Buffer.from([HEADER, BUY, SELL].join('\r\n')) }]);
    recompute(vault.db, ZERODHA);
    const test = testApp({}, vault.db);
    const { positions } = (await (await send(test, '/api/positions')).json()) as {
      positions: { ref: string }[];
    };
    const ref = positions[0]?.ref ?? '';
    const saved = await send(test, `/api/positions/${ref}/journal`, json('PUT', ENTRY));
    const { id } = (await saved.json()) as { id: string };
    await run(test, id, vault.db);
  });
}

describe('uploading screenshots', () => {
  it('stores a WebP, serves it back, lists it on the position, and deletes it', async () => {
    await withEntry(async (test, entryId) => {
      const created = await send(test, `/api/journal/${entryId}/attachments`, upload(PIXEL));
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      const served = await send(test, `/api/attachments/${id}`);
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toBe('image/webp');
      expect(served.headers.get('x-content-type-options')).toBe('nosniff');
      // A deleted screenshot is never shown from a cache.
      expect(served.headers.get('cache-control')).toBe('no-store');
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(PIXEL);
      expect((await send(test, `/api/attachments/${id}`, { method: 'DELETE' })).status).toBe(200);
      expect((await send(test, `/api/attachments/${id}`)).status).toBe(404);
      expect((await send(test, `/api/attachments/${id}`, { method: 'DELETE' })).status).toBe(404);
    });
  });

  it('refuses other types, oversized bodies, metadata and unknown entries', async () => {
    await withEntry(async (test, entryId) => {
      const path = `/api/journal/${entryId}/attachments`;
      expect((await send(test, path, upload(PIXEL, 'image/png'))).status).toBe(415);
      expect((await send(test, path, upload(new Uint8Array(MAX_ATTACHMENT_BYTES + 1)))).status).toBe(413);
      const exif = webp([
        ['VP8L', image.subarray(0, 13)],
        ['EXIF', Buffer.from('GPS 12.97N')],
      ]);
      const refused = await send(test, path, upload(exif));
      expect(refused.status).toBe(400);
      expect(await refused.text()).not.toContain('GPS');
      expect((await send(test, path, upload(Buffer.from('not an image at all, honestly')))).status).toBe(400);
      expect((await send(test, '/api/journal/jnl_nope/attachments', upload(PIXEL))).status).toBe(404);
    });
  });

  it(`holds at most ${String(MAX_ATTACHMENTS_PER_ENTRY)} screenshots per entry`, async () => {
    await withEntry(async (test, entryId) => {
      for (let n = 0; n < MAX_ATTACHMENTS_PER_ENTRY; n += 1) {
        expect((await send(test, `/api/journal/${entryId}/attachments`, upload(PIXEL))).status).toBe(201);
      }
      expect((await send(test, `/api/journal/${entryId}/attachments`, upload(PIXEL))).status).toBe(409);
    });
  });
});

describe('merging colliding entries', () => {
  it('keeps the chosen entry, fills its gaps, moves tags and screenshots, and resolves the issue', async () => {
    await withEntry(async (test, firstId, db) => {
      db.prepare("INSERT INTO tag (id, kind, name) VALUES ('tag_fomo', 'mistake', 'FOMO')").run();
      db.prepare(
        "UPDATE journal_entry SET thesis = 'Breakout', initial_stop_micro = 95000000, reviewed_at = '2026-10-01T00:00:00Z' WHERE id = ?",
      ).run(firstId);
      db.prepare(
        `INSERT INTO journal_entry (id, anchor_account_id, anchor_instrument_key, anchor_bucket, anchor_key, status,
           thesis, initial_stop_micro, planned_target_micro, review_note, created_at, updated_at)
         SELECT 'jnl_second', anchor_account_id, anchor_instrument_key, anchor_bucket, anchor_key, 'unattached',
           'Earnings run-up', 90000000, 130000000, 'Sold early', 'x', 'x' FROM journal_entry WHERE id = ?`,
      ).run(firstId);
      db.prepare(
        "INSERT INTO journal_tag (journal_entry_id, tag_id) VALUES ('jnl_second', 'tag_fomo')",
      ).run();
      expect((await send(test, '/api/journal/jnl_second/attachments', upload(PIXEL))).status).toBe(201);
      recompute(db, ZERODHA);
      const issue = db
        .prepare("SELECT id FROM issue WHERE kind = 'journal_collision' AND status = 'open'")
        .pluck()
        .get() as string;

      expect(
        (await send(test, `/api/issues/${issue}/merge`, json('POST', { intoId: 'jnl_other' }))).status,
      ).toBe(400);
      expect((await send(test, `/api/issues/${issue}/merge`, json('POST', { intoId: firstId }))).status).toBe(
        200,
      );

      const entries = db
        .prepare(
          'SELECT id, thesis, initial_stop_micro, planned_target_micro, review_note, reviewed_at FROM journal_entry',
        )
        .all();
      expect(entries).toEqual([
        {
          id: firstId,
          thesis: 'Breakout\n\nEarnings run-up',
          initial_stop_micro: 95000000n,
          planned_target_micro: 130000000n,
          review_note: 'Sold early',
          // The other entry was never reviewed, so the merged one needs a review.
          reviewed_at: null,
        },
      ]);
      expect(db.prepare('SELECT journal_entry_id FROM journal_tag').pluck().all()).toEqual([firstId]);
      expect(db.prepare('SELECT journal_entry_id FROM attachment').pluck().all()).toEqual([firstId]);
      expect(db.prepare('SELECT status FROM issue WHERE id = ?').pluck().get(issue)).toBe('resolved');
      expect((await send(test, `/api/issues/${issue}/merge`, json('POST', { intoId: firstId }))).status).toBe(
        404,
      );
    });
  });
});

describe('merging, the other cases', () => {
  function collide(firstId: string, db: Database.Database, second: { reviewedAt: string | null }): string {
    db.prepare(
      `INSERT INTO journal_entry (id, anchor_account_id, anchor_instrument_key, anchor_bucket, anchor_key, status,
         thesis, reviewed_at, created_at, updated_at)
       SELECT 'jnl_second', anchor_account_id, anchor_instrument_key, anchor_bucket, anchor_key, 'unattached',
         'Second', ?, 'x', 'x' FROM journal_entry WHERE id = ?`,
    ).run(second.reviewedAt, firstId);
    recompute(db, ZERODHA);
    return db
      .prepare("SELECT id FROM issue WHERE kind = 'journal_collision' AND status = 'open'")
      .pluck()
      .get() as string;
  }

  it('merges into the second entry, keeps the latest review when both were reviewed, and one copy of a shared tag', async () => {
    await withEntry(async (test, firstId, db) => {
      db.prepare("INSERT INTO tag (id, kind, name) VALUES ('tag_fomo', 'mistake', 'FOMO')").run();
      db.prepare(
        "UPDATE journal_entry SET thesis = 'First', reviewed_at = '2026-10-01T00:00:00Z' WHERE id = ?",
      ).run(firstId);
      const issue = collide(firstId, db, { reviewedAt: '2026-10-05T00:00:00Z' });
      db.prepare(
        "INSERT INTO journal_tag (journal_entry_id, tag_id) VALUES (?, 'tag_fomo'), ('jnl_second', 'tag_fomo')",
      ).run(firstId);
      expect(
        (await send(test, `/api/issues/${issue}/merge`, json('POST', { intoId: 'jnl_second' }))).status,
      ).toBe(200);
      expect(db.prepare('SELECT id, thesis, reviewed_at FROM journal_entry').all()).toEqual([
        { id: 'jnl_second', thesis: 'Second\n\nFirst', reviewed_at: '2026-10-05T00:00:00Z' },
      ]);
      expect(db.prepare('SELECT journal_entry_id, tag_id FROM journal_tag').all()).toEqual([
        { journal_entry_id: 'jnl_second', tag_id: 'tag_fomo' },
      ]);
    });
  });

  it(`refuses a merge that would hold more than ${String(MAX_ATTACHMENTS_PER_ENTRY)} screenshots`, async () => {
    await withEntry(async (test, firstId, db) => {
      const issue = collide(firstId, db, { reviewedAt: null });
      for (let n = 0; n < MAX_ATTACHMENTS_PER_ENTRY; n += 1) {
        expect((await send(test, `/api/journal/${firstId}/attachments`, upload(PIXEL))).status).toBe(201);
      }
      expect((await send(test, '/api/journal/jnl_second/attachments', upload(PIXEL))).status).toBe(201);
      expect((await send(test, `/api/issues/${issue}/merge`, json('POST', { intoId: firstId }))).status).toBe(
        409,
      );
      expect(db.prepare('SELECT count(*) FROM journal_entry').pluck().get()).toBe(2n);
    });
  });
});
