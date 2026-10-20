// Setup and mistake tags (PRD §4 settings, §10 journal). A journal entry has at most one setup tag
// (`journal_entry.setup_tag_id`) and any number of linked tags (`journal_tag`). Tag names follow the profile-label
// rules (free text, NFC, no identifier shapes) and are unique per kind ignoring case; migration 0004 backs that up.
// Deleting or merging a tag only changes tag links: a journal entry itself is never deleted (PRD §10.1).
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { acceptLabel, clashes, label, parse, ProfileError, write } from './profiles.js';

export const TAG_KINDS = ['setup', 'mistake'] as const;
export type TagKind = (typeof TAG_KINDS)[number];

export const tagInputSchema = z.object({ kind: z.enum(TAG_KINDS), name: label }).strict();
export const renameTagSchema = z.object({ name: label }).strict();
export const mergeTagSchema = z.object({ intoId: z.string().min(1).max(64) }).strict();

export interface TagSummary {
  readonly id: string;
  readonly kind: TagKind;
  readonly name: string;
  /** Journal entries that use it, as their setup or as a linked tag. */
  readonly uses: number;
}

interface TagRow {
  readonly id: string;
  readonly kind: TagKind;
  readonly name: string;
  readonly uses: bigint;
}

const USES = `(SELECT count(*) FROM journal_entry e
   WHERE e.setup_tag_id = t.id OR EXISTS (SELECT 1 FROM journal_tag l WHERE l.journal_entry_id = e.id AND l.tag_id = t.id))`;

/** Setup tags, then mistake tags, each by name ignoring case. */
export function listTags(db: Database.Database): TagSummary[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.kind, t.name, ${USES} AS uses FROM tag t
       ORDER BY CASE t.kind WHEN 'setup' THEN 0 ELSE 1 END, lower(t.name), t.name`,
    )
    .all() as TagRow[];
  return rows.map((row) => ({ id: row.id, kind: row.kind, name: row.name, uses: Number(row.uses) }));
}

function kindOf(db: Database.Database, id: string): TagKind {
  const kind: unknown = db.prepare('SELECT kind FROM tag WHERE id = ?').pluck().get(id);
  if (kind !== 'setup' && kind !== 'mistake') throw new ProfileError('not_found');
  return kind;
}

function namesOfKind(db: Database.Database, kind: TagKind, exceptId: string): unknown[] {
  return db.prepare('SELECT name FROM tag WHERE kind = ? AND id <> ?').pluck().all(kind, exceptId);
}

export function createTag(db: Database.Database, input: unknown): string {
  const parsed = parse(tagInputSchema, input);
  const name = acceptLabel(parsed.name);
  return write(db, () => {
    if (clashes(namesOfKind(db, parsed.kind, ''), name)) throw new ProfileError('conflict');
    const id = `tag_${randomUUID()}`;
    db.prepare('INSERT INTO tag (id, kind, name) VALUES (?, ?, ?)').run(id, parsed.kind, name);
    return id;
  });
}

export function renameTag(db: Database.Database, id: string, input: unknown): void {
  const name = acceptLabel(parse(renameTagSchema, input).name);
  write(db, () => {
    if (clashes(namesOfKind(db, kindOf(db, id), id), name)) throw new ProfileError('conflict');
    db.prepare('UPDATE tag SET name = ? WHERE id = ?').run(name, id);
  });
}

function usesOf(db: Database.Database, id: string): number {
  const uses: unknown = db.prepare(`SELECT ${USES} FROM tag t WHERE t.id = ?`).pluck().get(id);
  return Number(uses);
}

/** Deletes a tag and its links (the schema clears setup tags and cascades links); returns the entries that lost it. */
export function deleteTag(db: Database.Database, id: string): number {
  return write(db, () => {
    kindOf(db, id);
    const detached = usesOf(db, id);
    db.prepare('DELETE FROM tag WHERE id = ?').run(id);
    return detached;
  });
}

/**
 * Merges a tag into another of the same kind: entries that used it use the target instead (a link the entry
 * already has is not duplicated), then the tag is deleted. Returns the entries that used it.
 */
export function mergeTag(db: Database.Database, id: string, input: unknown): number {
  const { intoId } = parse(mergeTagSchema, input);
  return write(db, () => {
    const kind = kindOf(db, id);
    if (kindOf(db, intoId) !== kind || intoId === id) throw new ProfileError('invalid');
    const merged = usesOf(db, id);
    db.prepare('UPDATE journal_entry SET setup_tag_id = ? WHERE setup_tag_id = ?').run(intoId, id);
    db.prepare(
      `INSERT OR IGNORE INTO journal_tag (journal_entry_id, tag_id)
       SELECT journal_entry_id, ? FROM journal_tag WHERE tag_id = ?`,
    ).run(intoId, id);
    db.prepare('DELETE FROM tag WHERE id = ?').run(id);
    return merged;
  });
}
