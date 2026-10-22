// Journal anchors (S10c, ADR-0018, PRD §10.1). An entry's anchor is the `<dedup key>#<bucket>` of the fill that
// opened its position when it was written (an opening-lot adjustment's dedup key is its id). After every recompute
// the entry attaches to whichever position now contains that fill: older history can make another fill the opening
// one, and the entry follows. A lost anchor (its import undone) parks the entry as unattached; it is never deleted.
// Two entries on one position collide.
import { createHash } from 'node:crypto';
import type { FillAllocation, Position } from '@bhavbook/core';
import type Database from 'better-sqlite3';

/** Open positions last, then by when they closed or opened: the "live" one of several sharing an anchor. */
const liveRank = (position: Position): string =>
  position.closedAtUtc === null ? `1${position.openedAtUtc}` : `0${position.closedAtUtc}`;

/**
 * Every fill anchor a position contains (its buys, sells and orphaned sells), to the positions containing it in
 * live-last order (a converted lot's sold part stays on the old ISIN; the live one is the new ISIN).
 */
function positionsByAnchor(
  allocations: readonly FillAllocation[],
  positions: readonly Position[],
): ReadonlyMap<string, readonly Position[]> {
  const anchorOf = new Map(
    allocations.map((allocation) => [allocation.key, `${allocation.dedupKey}#${allocation.bucket}`]),
  );
  const ranked = positions.map((position) => ({ position, rank: liveRank(position) }));
  ranked.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  const byAnchor = new Map<string, Position[]>();
  for (const { position } of ranked) {
    const members = [
      ...position.lots.flatMap((lot) => (lot.exit === null ? [lot.entry] : [lot.entry, lot.exit])),
      ...position.orphans.map((orphan) => orphan.allocation),
    ];
    const anchors = new Set([position.anchorKey, ...members.flatMap((key) => anchorOf.get(key) ?? [])]);
    for (const anchor of anchors) {
      const list = byAnchor.get(anchor) ?? [];
      list.push(position);
      byAnchor.set(anchor, list);
    }
  }
  return byAnchor;
}

interface EntryRow {
  readonly id: string;
  readonly anchor_instrument_key: string;
  readonly anchor_bucket: string;
  readonly anchor_key: string;
  readonly reviewed_at: string | null;
}

/**
 * Of the positions containing the anchor, an open one on the entry's own instrument keeps it (a demerger child
 * shares its parent's anchor); otherwise the live one takes it. A reviewed entry is about the position it reviewed:
 * it stays on its own instrument (the latest such position, open or closed) before following the live one, so a
 * review of a converted lot's sold part never moves to the new ISIN. Null: the anchor is gone.
 */
export function choosePosition(
  candidates: readonly Position[],
  instrumentKey: string,
  reviewed = false,
): Position | null {
  const own = candidates.filter((candidate) => candidate.instrumentKey === instrumentKey);
  return (
    own.find((candidate) => candidate.state === 'OPEN') ??
    (reviewed ? own.at(-1) : undefined) ??
    candidates.at(-1) ??
    null
  );
}

export interface JournalFindings {
  /** Fingerprint (entry id) -> subject, for `journal_unattached`. */
  readonly unattached: Map<string, string>;
  /**
   * Fingerprint (the colliding entries) -> subject, for `journal_collision`. Keyed by the entries, not the
   * position: a position's id changes when older history merges it, and a dismissed collision must stay dismissed.
   */
  readonly collisions: Map<string, string>;
}

const collisionKey = (ids: readonly string[]): string =>
  createHash('sha256').update(ids.join('\u0000')).digest('hex').slice(0, 24);

/**
 * Re-attaches every journal entry of the account. Call inside the recompute, after the positions are written:
 * attachments to the old positions went with them (migration 0005 cascades).
 */
export function attachJournal(
  db: Database.Database,
  accountId: string,
  allocations: readonly FillAllocation[],
  positions: readonly Position[],
): JournalFindings {
  const byAnchor = positionsByAnchor(allocations, positions);
  const entries = db
    .prepare(
      `SELECT id, anchor_instrument_key, anchor_bucket, anchor_key, reviewed_at FROM journal_entry
       WHERE anchor_account_id = ? ORDER BY id`,
    )
    .all(accountId) as EntryRow[];
  const attach = db.prepare('INSERT INTO journal_attachment (journal_entry_id, position_id) VALUES (?, ?)');
  const attached = db.prepare(
    `UPDATE journal_entry SET status = 'attached', anchor_instrument_key = ?
     WHERE id = ? AND (status <> 'attached' OR anchor_instrument_key <> ?)`,
  );
  const parked = db.prepare(
    "UPDATE journal_entry SET status = 'unattached' WHERE id = ? AND status <> 'unattached'",
  );
  const unattached = new Map<string, string>();
  const byPosition = new Map<string, string[]>();
  for (const entry of entries) {
    const position = choosePosition(
      byAnchor.get(entry.anchor_key) ?? [],
      entry.anchor_instrument_key,
      entry.reviewed_at !== null,
    );
    if (position === null) {
      parked.run(entry.id);
      const subject = {
        journalEntryId: entry.id,
        instrumentKey: entry.anchor_instrument_key,
        bucket: entry.anchor_bucket,
      };
      unattached.set(entry.id, JSON.stringify(subject));
      continue;
    }
    attach.run(entry.id, position.id);
    attached.run(position.instrumentKey, entry.id, position.instrumentKey);
    const ids = byPosition.get(position.id) ?? [];
    ids.push(entry.id);
    byPosition.set(position.id, ids);
  }
  const collisions = new Map<string, string>();
  for (const [positionId, ids] of byPosition) {
    if (ids.length > 1)
      collisions.set(collisionKey(ids), JSON.stringify({ positionId, journalEntryIds: ids }));
  }
  return { unattached, collisions };
}
