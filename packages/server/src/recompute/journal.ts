// Journal anchors (S10c, ADR-0018, PRD §10.1). An entry's anchor is the `<dedup key>#<bucket>` of the fill that
// opened its position when it was written. After every recompute the entry attaches to whichever position now
// contains that fill: older history can make another fill the opening one, and the entry follows. A lost anchor
// (its import undone) parks the entry as unattached; it is never deleted. Two entries on one position collide.
import type { FillAllocation, Position } from '@bhavbook/core';
import type Database from 'better-sqlite3';

/**
 * Open positions last, then by when they closed or opened: the "live" one of several positions sharing an anchor
 * (a converted lot's sold part stays on the old ISIN; the live one is the new ISIN).
 */
function liveLast(a: Position, b: Position): number {
  const rank = (position: Position): string =>
    position.closedAtUtc === null ? `1${position.openedAtUtc}` : `0${position.closedAtUtc}`;
  return rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0;
}

/** Every fill anchor a position contains (its buys, sells and orphaned sells), to the positions containing it. */
function positionsByAnchor(
  allocations: readonly FillAllocation[],
  positions: readonly Position[],
): ReadonlyMap<string, readonly Position[]> {
  const anchorOf = new Map(
    allocations.map((allocation) => [allocation.key, `${allocation.dedupKey}#${allocation.bucket}`]),
  );
  const byAnchor = new Map<string, Position[]>();
  for (const position of [...positions].sort(liveLast)) {
    const members = new Set<string>([
      ...position.lots.flatMap((lot) => (lot.exit === null ? [lot.entry] : [lot.entry, lot.exit])),
      ...position.orphans.map((orphan) => orphan.allocation),
    ]);
    const anchors = new Set([position.anchorKey, ...[...members].flatMap((key) => anchorOf.get(key) ?? [])]);
    for (const anchor of anchors) byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), position]);
  }
  return byAnchor;
}

interface EntryRow {
  readonly id: string;
  readonly anchor_instrument_key: string;
  readonly anchor_bucket: string;
  readonly anchor_key: string;
}

export interface JournalFindings {
  /** Fingerprint (entry id) -> subject, for `journal_unattached`. */
  readonly unattached: Map<string, string>;
  /** Fingerprint (position id) -> subject, for `journal_collision`. */
  readonly collisions: Map<string, string>;
}

/**
 * Re-attaches every journal entry of the account (call after the positions are written; attachments to the old
 * positions went with them). Of several positions containing the anchor, an open one on the entry's own instrument
 * keeps it (a demerger child shares its parent's anchor); otherwise the live one takes it.
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
      `SELECT id, anchor_instrument_key, anchor_bucket, anchor_key FROM journal_entry
       WHERE anchor_account_id = ? ORDER BY id`,
    )
    .all(accountId) as EntryRow[];
  const attach = db.prepare('INSERT INTO journal_attachment (journal_entry_id, position_id) VALUES (?, ?)');
  const update = db.prepare(
    `UPDATE journal_entry SET status = ?, anchor_instrument_key = ?
     WHERE id = ? AND (status <> ? OR anchor_instrument_key <> ?)`,
  );
  const unattached = new Map<string, string>();
  const byPosition = new Map<string, string[]>();
  for (const entry of entries) {
    const candidates = byAnchor.get(entry.anchor_key) ?? [];
    const position =
      candidates.find(
        (candidate) => candidate.instrumentKey === entry.anchor_instrument_key && candidate.state === 'OPEN',
      ) ?? candidates.at(-1);
    if (position === undefined) {
      update.run(
        'unattached',
        entry.anchor_instrument_key,
        entry.id,
        'unattached',
        entry.anchor_instrument_key,
      );
      unattached.set(
        entry.id,
        JSON.stringify({
          journalEntryId: entry.id,
          instrumentKey: entry.anchor_instrument_key,
          bucket: entry.anchor_bucket,
        }),
      );
      continue;
    }
    attach.run(entry.id, position.id);
    update.run('attached', position.instrumentKey, entry.id, 'attached', position.instrumentKey);
    byPosition.set(position.id, [...(byPosition.get(position.id) ?? []), entry.id]);
  }
  const collisions = new Map<string, string>();
  for (const [positionId, ids] of byPosition) {
    if (ids.length > 1) collisions.set(positionId, JSON.stringify({ positionId, journalEntryIds: ids }));
  }
  return { unattached, collisions };
}
