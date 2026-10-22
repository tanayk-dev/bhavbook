// Journal entries and reviews (PRD §5.3, §10.1; plan S14a). An entry is created on a position's first save, anchored
// to the fill that opened the position (its `anchor_key`), and attached right away; after every recompute it follows
// whichever position holds that fill (S10c). Drafts work on open positions. Once a position has closed its initial
// stop is fixed: R is measured against the stop as planned, never one moved after the outcome is known (Q11).
// Reviewing marks a closed position's entries reviewed (creating an empty entry if it has none); reopening clears it.
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { write } from './profiles.js';
import { ActionError } from './errors.js';
import { journalOf, positionById, positionIdOf } from './positions.js';

const MAX_TEXT = 10_000;
const MAX_MISTAKES = 20;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A non-negative amount in micro-rupees, as a decimal string (at most ₹10^12). */
const micro = z.string().regex(/^(0|[1-9]\d{0,17})$/);
const positiveMicro = z.string().regex(/^[1-9]\d{0,17}$/);
const text = z.string().max(MAX_TEXT);

/** The whole editable entry: every save sends every field (null clears one). */
export const journalInputSchema = z
  .object({
    /** Which of two colliding entries this edits; without one the position's only entry (or a new one). */
    entryId: z.string().regex(ID).optional(),
    setupTagId: z.string().regex(ID).nullable(),
    mistakeTagIds: z.array(z.string().regex(ID)).max(MAX_MISTAKES),
    thesis: text.nullable(),
    initialStopMicro: micro.nullable(),
    plannedStopMicro: micro.nullable(),
    plannedTargetMicro: micro.nullable(),
    plannedRiskMicro: positiveMicro.nullable(),
    reviewNote: text.nullable(),
  })
  .strict();

export type JournalInput = z.infer<typeof journalInputSchema>;

export interface JournalOptions {
  readonly now?: () => Date;
}

/** Trimmed NFC text; empty is no text. */
function cleanText(value: string | null): string | null {
  const cleaned = value?.normalize('NFC').trim() ?? '';
  return cleaned === '' ? null : cleaned;
}

const amount = (value: string | null): bigint | null => (value === null ? null : BigInt(value));

function tagKinds(db: Database.Database, ids: readonly string[]): Map<string, string> {
  const read = db.prepare('SELECT kind FROM tag WHERE id = ?').pluck();
  return new Map(
    ids.map((id): [string, string] => {
      const kind: unknown = read.get(id);
      return [id, typeof kind === 'string' ? kind : ''];
    }),
  );
}

function checkTags(db: Database.Database, input: JournalInput): void {
  const kinds = tagKinds(db, [
    ...(input.setupTagId === null ? [] : [input.setupTagId]),
    ...input.mistakeTagIds,
  ]);
  const setupOk = input.setupTagId === null || kinds.get(input.setupTagId) === 'setup';
  const mistakesOk = input.mistakeTagIds.every((id) => kinds.get(id) === 'mistake');
  if (!setupOk || !mistakesOk)
    throw new ActionError('a tag is missing or of the wrong kind', { code: 'invalid' });
}

/** A new, empty entry anchored to the position's opening fill and attached to it. */
function createEntry(db: Database.Database, positionId: string, at: string): string {
  const position = db
    .prepare('SELECT account_id, instrument_key, bucket, anchor_key FROM position WHERE id = ?')
    .get(positionId) as
    { account_id: string; instrument_key: string; bucket: string; anchor_key: string } | undefined;
  if (position === undefined) throw new ActionError('no such position', { code: 'not_found' });
  const id = `jnl_${randomUUID()}`;
  db.prepare(
    `INSERT INTO journal_entry (id, anchor_account_id, anchor_instrument_key, anchor_bucket, anchor_key, status,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'attached', ?, ?)`,
  ).run(id, position.account_id, position.instrument_key, position.bucket, position.anchor_key, at, at);
  db.prepare('INSERT INTO journal_attachment (journal_entry_id, position_id) VALUES (?, ?)').run(
    id,
    positionId,
  );
  return id;
}

/** The entry a save edits: the named one (attached here), the only one, or a new one. */
function entryFor(db: Database.Database, positionId: string, entryId: string | undefined, at: string) {
  const attached = journalOf(db, positionId);
  if (entryId !== undefined) {
    const named = attached.find((entry) => entry.id === entryId);
    if (named === undefined) throw new ActionError('no such journal entry here', { code: 'not_found' });
    return named;
  }
  if (attached.length > 1) throw new ActionError('the position has two entries', { code: 'conflict' });
  const [only] = attached;
  if (only !== undefined) return only;
  const id = createEntry(db, positionId, at);
  return journalOf(db, positionId).find((entry) => entry.id === id) ?? null;
}

/** Saves a position's journal entry (creating it on first save); returns its id. */
export function saveJournal(
  db: Database.Database,
  ref: string,
  input: JournalInput,
  options: JournalOptions = {},
): string {
  const at = (options.now?.() ?? new Date()).toISOString();
  const positionId = positionIdOf(ref);
  return write(db, () => {
    const position = positionById(db, positionId);
    checkTags(db, input);
    const entry = entryFor(db, positionId, input.entryId, at);
    if (entry === null) throw new ActionError('the journal entry could not be created');
    const initialStop = amount(input.initialStopMicro);
    if (position.state === 'CLOSED' && initialStop !== entry.initialStopMicro) {
      throw new ActionError('the initial stop is fixed once the position closes', { code: 'conflict' });
    }
    db.prepare(
      `UPDATE journal_entry SET setup_tag_id = ?, thesis = ?, initial_stop_micro = ?, planned_stop_micro = ?,
         planned_target_micro = ?, planned_risk_micro = ?, review_note = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.setupTagId,
      cleanText(input.thesis),
      initialStop,
      amount(input.plannedStopMicro),
      amount(input.plannedTargetMicro),
      amount(input.plannedRiskMicro),
      cleanText(input.reviewNote),
      at,
      entry.id,
    );
    db.prepare(
      "DELETE FROM journal_tag WHERE journal_entry_id = ? AND tag_id IN (SELECT id FROM tag WHERE kind = 'mistake')",
    ).run(entry.id);
    const link = db.prepare('INSERT OR IGNORE INTO journal_tag (journal_entry_id, tag_id) VALUES (?, ?)');
    for (const tagId of input.mistakeTagIds) link.run(entry.id, tagId);
    return entry.id;
  });
}

/**
 * Marks a closed position reviewed (every entry on it not yet reviewed; an empty entry when it has none) or reopens
 * it. Only closed positions are reviewed: an open one is still being traded. Reopening works in any state, so a
 * review from before the position reopened (a later buy) can be cleared.
 */
export function setReviewed(
  db: Database.Database,
  ref: string,
  reviewed: boolean,
  options: JournalOptions = {},
): void {
  const at = (options.now?.() ?? new Date()).toISOString();
  const positionId = positionIdOf(ref);
  write(db, () => {
    const position = positionById(db, positionId);
    if (reviewed && position.state !== 'CLOSED') {
      throw new ActionError('only a closed position is reviewed', { code: 'invalid' });
    }
    if (reviewed && journalOf(db, positionId).length === 0) createEntry(db, positionId, at);
    // Only entries whose state changes are touched: reviewing twice keeps the first review's time.
    db.prepare(
      `UPDATE journal_entry SET reviewed_at = ?, updated_at = ?
       WHERE id IN (SELECT journal_entry_id FROM journal_attachment WHERE position_id = ?)
         AND (reviewed_at IS NULL) = ?`,
    ).run(reviewed ? at : null, at, positionId, reviewed ? 1n : 0n);
  });
}
