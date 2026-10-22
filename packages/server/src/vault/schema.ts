// Identity and allow-listing of vault schemas. A restored database is trusted only if its schema objects are exactly
// what the bundled migrations produce at that version: no extra triggers, views or tables (security review, S4).
import { chmodSync } from 'node:fs';
import Database from 'better-sqlite3';
import { migrate, type Migration } from './migrations.js';

/** `PRAGMA application_id` of every BhavBook vault: the ASCII bytes 'BHAV'. Set by migration 0001. */
export const APPLICATION_ID = 0x42484156;

/** Settings applied to every connection we open, including staged restores. */
/**
 * Makes a vault file readable and writable by its owner only (SQLite gives its -wal and -shm files the same mode).
 * Windows has no such mode bits: the user profile's ACLs protect the file there.
 */
export function restrictToOwner(file: string): void {
  if (process.platform !== 'win32') chmodSync(file, OWNER_ONLY);
}

const OWNER_ONLY = 0o600;

export function hardenConnection(db: Database.Database): void {
  db.defaultSafeIntegers(true);
  // Schema-defined objects (views, triggers, defaults) may not call functions with side effects.
  db.pragma('trusted_schema = OFF');
  db.pragma('cell_size_check = ON');
}

/**
 * Every schema object as `type|name|table|sql`, sorted. Nothing is excluded by name pattern (a LIKE filter would let a
 * hostile `sqlitex_…` or `SQLITE_…` trigger through). Only SQLite's planner statistics tables are skipped, by exact
 * name, because ANALYZE may create them in a real vault; they hold planner hints, not executable SQL.
 */
export function schemaFingerprint(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE NOT (type = 'table' AND name IN ('sqlite_stat1', 'sqlite_stat4'))",
    )
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  return rows
    .map((row) => [row.type, row.name, row.tbl_name, (row.sql ?? '').replace(/\s+/g, ' ').trim()].join('|'))
    .sort();
}

const referenceCache = new Map<string, string[]>();

/** The schema fingerprint that the first `version` bundled migrations produce on an empty database. */
export function referenceFingerprint(migrations: readonly Migration[], version: number): string[] {
  const subset = migrations.filter((migration) => migration.version <= version);
  const cacheKey = subset.map((migration) => `${String(migration.version)}:${migration.sql}`).join('\n');
  const cached = referenceCache.get(cacheKey);
  if (cached) return cached;
  const db = new Database(':memory:');
  try {
    hardenConnection(db);
    migrate(db, subset);
    const fingerprint = schemaFingerprint(db);
    referenceCache.set(cacheKey, fingerprint);
    return fingerprint;
  } finally {
    db.close();
  }
}
