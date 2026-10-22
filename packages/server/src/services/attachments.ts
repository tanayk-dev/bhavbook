// Journal screenshots (PRD §3.3, ADR-0020; plan S14a). The browser re-encodes every image to WebP through a canvas,
// which drops EXIF and location data, and keeps it within 1 MB. The server trusts none of that: it accepts only a
// well-formed WebP RIFF container of at most 1 MB with no EXIF or XMP chunk, and stores it as a BLOB.
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ActionError } from './errors.js';
import { write } from './profiles.js';

export const MAX_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_ATTACHMENTS_PER_ENTRY = 20;
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
/** Image data chunks: a WebP file has exactly one of these. */
const IMAGE_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X']);
/** Metadata chunks: never stored (they carry camera, time and location details). */
const METADATA_CHUNKS = new Set(['EXIF', 'XMP ']);

const fourcc = (bytes: Uint8Array, at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));

const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)) +
  (bytes[at + 3] ?? 0) * 0x1000000;

export type WebpProblem = 'too_large' | 'not_webp' | 'has_metadata';

/** Why these bytes are not an acceptable screenshot, or null when they are. */
export function webpProblem(bytes: Uint8Array): WebpProblem | null {
  if (bytes.length > MAX_ATTACHMENT_BYTES) return 'too_large';
  if (bytes.length < HEADER_BYTES + CHUNK_HEADER_BYTES) return 'not_webp';
  if (fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WEBP') return 'not_webp';
  if (u32(bytes, 4) + 8 !== bytes.length) return 'not_webp';
  let at = HEADER_BYTES;
  let images = 0;
  while (at < bytes.length) {
    if (at + CHUNK_HEADER_BYTES > bytes.length) return 'not_webp';
    const id = fourcc(bytes, at);
    const size = u32(bytes, at + 4);
    if (METADATA_CHUNKS.has(id)) return 'has_metadata';
    if (IMAGE_CHUNKS.has(id)) images += 1;
    // Chunks are padded to an even length.
    at += CHUNK_HEADER_BYTES + size + (size % 2);
    if (at > bytes.length) return 'not_webp';
  }
  return images > 0 ? null : 'not_webp';
}

export interface AttachmentOptions {
  readonly now?: () => Date;
}

/** Stores a screenshot on a journal entry; returns its id. */
export function addAttachment(
  db: Database.Database,
  entryId: string,
  bytes: Uint8Array,
  options: AttachmentOptions = {},
): string {
  const problem = webpProblem(bytes);
  if (problem !== null)
    throw new ActionError(`not an acceptable screenshot: ${problem}`, { code: 'invalid' });
  const at = (options.now?.() ?? new Date()).toISOString();
  return write(db, () => {
    const exists: unknown = db.prepare('SELECT 1 FROM journal_entry WHERE id = ?').pluck().get(entryId);
    if (exists === undefined) throw new ActionError('no such journal entry', { code: 'not_found' });
    const count: unknown = db
      .prepare('SELECT count(*) FROM attachment WHERE journal_entry_id = ?')
      .pluck()
      .get(entryId);
    if (typeof count === 'bigint' && count >= BigInt(MAX_ATTACHMENTS_PER_ENTRY)) {
      throw new ActionError('the entry has as many screenshots as it can hold', { code: 'conflict' });
    }
    const id = `att_${randomUUID()}`;
    db.prepare(
      "INSERT INTO attachment (id, journal_entry_id, mime, data, created_at) VALUES (?, ?, 'image/webp', ?, ?)",
    ).run(id, entryId, Buffer.from(bytes), at);
    db.prepare('UPDATE journal_entry SET updated_at = ? WHERE id = ?').run(at, entryId);
    return id;
  });
}

/** A screenshot's bytes; ActionError not_found when there is none. */
export function readAttachment(db: Database.Database, id: string): Uint8Array<ArrayBuffer> {
  const data: unknown = db.prepare('SELECT data FROM attachment WHERE id = ?').pluck().get(id);
  if (!Buffer.isBuffer(data)) throw new ActionError('no such screenshot', { code: 'not_found' });
  // A copy on its own ArrayBuffer: a valid response body under both the Node and the DOM typings.
  return new Uint8Array(data);
}

export function deleteAttachment(db: Database.Database, id: string, options: AttachmentOptions = {}): void {
  const at = (options.now?.() ?? new Date()).toISOString();
  write(db, () => {
    const entry: unknown = db
      .prepare('DELETE FROM attachment WHERE id = ? RETURNING journal_entry_id')
      .pluck()
      .get(id);
    if (typeof entry !== 'string') throw new ActionError('no such screenshot', { code: 'not_found' });
    db.prepare('UPDATE journal_entry SET updated_at = ? WHERE id = ?').run(at, entry);
  });
}
