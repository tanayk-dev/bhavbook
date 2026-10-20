// The `.bhav` backup container (ADR-0020): `BHAV` + format byte | u32 LE manifest length | manifest JSON | db bytes.
// Decoding validates every length before reading and verifies the SHA-256 of the database bytes.
import { createHash } from 'node:crypto';
import { BackupError } from './errors.js';

const MAGIC = Buffer.from('BHAV\u0001', 'latin1');
const HEADER_BYTES = MAGIC.length + 4;
export const MAX_MANIFEST_BYTES = 64 * 1024;
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'latin1');

export interface BackupMeta {
  readonly schemaVersion: number;
  readonly appVersion: string;
  readonly createdAt: string;
}

export interface BackupManifest extends BackupMeta {
  readonly format: 1;
  readonly dbBytes: number;
  readonly sha256: string;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function encodeBhav(db: Buffer, meta: BackupMeta): Buffer {
  const manifest: BackupManifest = { format: 1, ...meta, dbBytes: db.length, sha256: sha256(db) };
  const json = Buffer.from(JSON.stringify(manifest), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length, 0);
  return Buffer.concat([MAGIC, length, json, db]);
}

function parseManifest(json: Buffer): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(json.toString('utf8'));
  } catch {
    throw new BackupError('backup manifest is not valid JSON', { problem: 'not_a_backup' });
  }
  const manifest = value as Partial<BackupManifest> | null;
  if (
    manifest?.format !== 1 ||
    !Number.isSafeInteger(manifest.schemaVersion) ||
    !Number.isSafeInteger(manifest.dbBytes) ||
    typeof manifest.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
    typeof manifest.appVersion !== 'string' ||
    typeof manifest.createdAt !== 'string'
  ) {
    throw new BackupError('backup manifest is missing required fields', { problem: 'not_a_backup' });
  }
  return manifest as BackupManifest;
}

export function decodeBhav(file: Buffer): { manifest: BackupManifest; db: Buffer } {
  if (file.length < HEADER_BYTES || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupError('not a BhavBook backup (bad header)', { problem: 'not_a_backup' });
  }
  const manifestLength = file.readUInt32LE(MAGIC.length);
  if (manifestLength === 0 || manifestLength > MAX_MANIFEST_BYTES)
    throw new BackupError('backup manifest size is invalid', { problem: 'not_a_backup' });
  if (HEADER_BYTES + manifestLength > file.length)
    throw new BackupError('backup is truncated', { problem: 'corrupt' });
  const manifest = parseManifest(file.subarray(HEADER_BYTES, HEADER_BYTES + manifestLength));
  const db = file.subarray(HEADER_BYTES + manifestLength);
  if (db.length !== manifest.dbBytes)
    throw new BackupError('backup is truncated or has trailing bytes', { problem: 'corrupt' });
  if (sha256(db) !== manifest.sha256)
    throw new BackupError('backup checksum does not match; the file is corrupted', { problem: 'corrupt' });
  return { manifest, db };
}

/** True when the bytes start with the SQLite file header. */
export function looksLikeSqlite(db: Buffer): boolean {
  return db.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER);
}
