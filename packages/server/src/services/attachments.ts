// Journal screenshots (PRD §3.3, ADR-0020; plan S14a). The browser re-encodes every image to WebP through a canvas,
// which drops EXIF and location data, and keeps it within 1 MB. The server trusts none of that: it accepts only a
// still WebP of at most 1 MB made of the chunks a canvas writes (an optional VP8X header first, an optional colour
// profile and alpha, exactly one image), with no metadata declared or present, and stores it as a BLOB. Screenshots are not journal
// text: adding or deleting one leaves the entry's `updated_at` alone, so an open journal form never goes stale.
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ActionError } from './errors.js';
import { write } from './profiles.js';

export const MAX_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_ATTACHMENTS_PER_ENTRY = 20;
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
/** Image data: a still WebP has exactly one of these. */
const IMAGE_CHUNKS = new Set(['VP8 ', 'VP8L']);
/**
 * What may sit beside it (VP8X only first): alpha, and a colour profile, which Chromium's canvas encoder writes
 * (its sRGB profile, nothing personal; checked by the E2E). Anything else is refused: animation, unknown chunks.
 */
const SIDE_CHUNKS = new Set(['VP8X', 'ICCP', 'ALPH']);
/** Metadata chunks: never stored (they carry camera, time and location details). */
const METADATA_CHUNKS = new Set(['EXIF', 'XMP ']);
/** VP8X flags (the first payload byte): EXIF and XMP present, and animation. */
const VP8X_METADATA = 0x08 | 0x04;
const VP8X_ANIMATION = 0x02;

const fourcc = (bytes: Uint8Array, at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));

const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)) +
  (bytes[at + 3] ?? 0) * 0x1000000;

export type WebpProblem = 'too_large' | 'not_webp' | 'has_metadata';

/** Why one chunk is not acceptable at its place, or null. */
function chunkProblem(bytes: Uint8Array, id: string, at: number, first: boolean): WebpProblem | null {
  if (METADATA_CHUNKS.has(id)) return 'has_metadata';
  if (id === 'VP8X') {
    if (!first) return 'not_webp';
    const flags = bytes[at + CHUNK_HEADER_BYTES] ?? 0;
    if ((flags & VP8X_METADATA) !== 0) return 'has_metadata';
    if ((flags & VP8X_ANIMATION) !== 0) return 'not_webp';
    return null;
  }
  return IMAGE_CHUNKS.has(id) || SIDE_CHUNKS.has(id) ? null : 'not_webp';
}

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
    const problem = chunkProblem(bytes, id, at, at === HEADER_BYTES);
    if (problem !== null) return problem;
    if (IMAGE_CHUNKS.has(id)) images += 1;
    // Chunks are padded to an even length.
    at += CHUNK_HEADER_BYTES + size + (size % 2);
    if (at > bytes.length) return 'not_webp';
  }
  return images === 1 ? null : 'not_webp';
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
    // Fail closed whatever the integer mode of the connection.
    if (Number(count) >= MAX_ATTACHMENTS_PER_ENTRY) {
      throw new ActionError('the entry has as many screenshots as it can hold', { code: 'conflict' });
    }
    const id = `att_${randomUUID()}`;
    db.prepare(
      "INSERT INTO attachment (id, journal_entry_id, mime, data, created_at) VALUES (?, ?, 'image/webp', ?, ?)",
    ).run(id, entryId, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), at);
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

export function deleteAttachment(db: Database.Database, id: string): void {
  write(db, () => {
    const entry: unknown = db
      .prepare('DELETE FROM attachment WHERE id = ? RETURNING journal_entry_id')
      .pluck()
      .get(id);
    if (typeof entry !== 'string') throw new ActionError('no such screenshot', { code: 'not_found' });
  });
}
