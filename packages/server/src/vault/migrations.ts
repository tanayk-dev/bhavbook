// Forward-only, numbered SQL migrations (ADR-0020). Each runs in its own IMMEDIATE transaction, is recorded with a
// checksum, and runs with foreign keys off so table rebuilds can't cascade-delete data (checked before commit).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { VaultError } from './errors.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
);
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Reads `NNNN_name.sql` files; versions must start at 1 and have no gaps. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => {
      const match = FILE_PATTERN.exec(file);
      if (!match) throw new VaultError(`migration file names must be NNNN_name.sql (got ${file})`);
      return {
        version: Number.parseInt(match[1] ?? '', 10),
        name: match[2] ?? '',
        sql: readFileSync(path.join(dir, file), 'utf8'),
      };
    });
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new VaultError('migration versions must be 1..n with no gaps');
  });
  return migrations;
}

export function latestVersion(migrations: readonly Migration[] = loadMigrations()): number {
  return migrations.at(-1)?.version ?? 0;
}

export function migrationChecksum(migration: Migration): string {
  return createHash('sha256').update(migration.sql.replace(/\r\n/g, '\n')).digest('hex');
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

function hasMigrationsTable(db: Database.Database): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get() !==
    undefined
  );
}

/** Applied migrations in order; empty for a new database. Never writes. */
export function appliedMigrations(db: Database.Database): AppliedMigration[] {
  if (!hasMigrationsTable(db)) return [];
  const rows = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as {
    version: bigint | number;
    name: string;
    checksum: string;
  }[];
  return rows.map((row) => ({
    version: Number.parseInt(String(row.version), 10),
    name: row.name,
    checksum: row.checksum,
  }));
}

/** The highest applied migration, or 0 for an empty database. Never writes. */
export function currentVersion(db: Database.Database): number {
  return appliedMigrations(db).at(-1)?.version ?? 0;
}

/** Throws unless the applied history is exactly the first N bundled migrations (same names and SQL). */
export function assertHistoryMatches(
  applied: readonly AppliedMigration[],
  migrations: readonly Migration[],
): void {
  applied.forEach((entry, index) => {
    const bundled = migrations[index];
    if (entry.version !== index + 1) throw new VaultError('vault migration history has gaps');
    if (!bundled)
      throw new VaultError('this vault was written by a newer version of BhavBook; please upgrade');
    if (entry.name !== bundled.name || entry.checksum !== migrationChecksum(bundled)) {
      throw new VaultError(
        `migration ${String(entry.version)} differs from the one this vault was created with`,
      );
    }
  });
}

export interface MigrateOptions {
  /** Called once before the first pending migration (used for the pre-migration backup). */
  readonly beforeApply?: (from: number, to: number) => void;
  readonly now?: () => Date;
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT',
  );
}

function applyOne(db: Database.Database, migration: Migration, now: () => Date): void {
  db.transaction(() => {
    // Re-check inside the write lock: another process may have applied it meanwhile.
    if (currentVersion(db) >= migration.version) return;
    ensureMigrationsTable(db);
    db.exec(migration.sql);
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0)
      throw new VaultError(`migration ${String(migration.version)} broke foreign keys`);
    db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
      migration.version,
      migration.name,
      migrationChecksum(migration),
      now().toISOString(),
    );
  }).immediate();
}

export function migrate(
  db: Database.Database,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): { from: number; to: number } {
  const applied = appliedMigrations(db);
  assertHistoryMatches(applied, migrations);
  const from = applied.at(-1)?.version ?? 0;
  const pending = migrations.filter((migration) => migration.version > from);
  if (pending.length === 0) return { from, to: from };
  const to = latestVersion(migrations);
  options.beforeApply?.(from, to);
  // PRAGMA foreign_keys is a no-op inside a transaction, so switch it around each migration.
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as bigint | number;
  db.pragma('foreign_keys = OFF');
  try {
    for (const migration of pending) applyOne(db, migration, options.now ?? (() => new Date()));
  } finally {
    db.pragma(`foreign_keys = ${String(foreignKeys) === '1' ? 'ON' : 'OFF'}`);
  }
  return { from, to };
}
