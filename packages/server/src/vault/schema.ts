// Identity and allow-listing of vault schemas. A restored database is trusted only if its schema objects are exactly
// what the bundled migrations produce at that version: no extra triggers, views or tables (security review, S4).
import Database from 'better-sqlite3';
import { migrate, type Migration } from './migrations.js';

/** `PRAGMA application_id` of every BhavBook vault: the ASCII bytes 'BHAV'. Set by migration 0001. */
export const APPLICATION_ID = 0x42484156;

/** Settings applied to every connection we open, including staged restores. */
export function hardenConnection(db: Database.Database): void {
  db.defaultSafeIntegers(true);
  // Schema-defined objects (views, triggers, defaults) may not call functions with side effects.
  db.pragma('trusted_schema = OFF');
  db.pragma('cell_size_check = ON');
}

/** Every user schema object as `type|name|table|sql`, sorted. SQLite's own objects are excluded. */
export function schemaFingerprint(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
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
