// Forward-only, numbered SQL migrations (ADR-0020). Each runs in its own transaction and is recorded.
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
    if (migration.version !== index + 1) throw new VaultError(`migration versions must be 1..n with no gaps`);
  });
  return migrations;
}

export function latestVersion(migrations: readonly Migration[] = loadMigrations()): number {
  return migrations.at(-1)?.version ?? 0;
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT',
  );
}

/** The highest applied migration, or 0 for an empty database. */
export function currentVersion(db: Database.Database): number {
  ensureMigrationsTable(db);
  const row = db.prepare('SELECT max(version) AS version FROM schema_migrations').get() as {
    version: bigint | null;
  };
  return row.version === null ? 0 : Number.parseInt(row.version.toString(), 10);
}

export interface MigrateOptions {
  /** Called once before the first pending migration (used for the pre-migration backup). */
  readonly beforeApply?: (from: number, to: number) => void;
  readonly now?: () => Date;
}

export function migrate(
  db: Database.Database,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): { from: number; to: number } {
  const from = currentVersion(db);
  const to = latestVersion(migrations);
  if (from > to)
    throw new VaultError('this vault was written by a newer version of BhavBook; please upgrade');
  const pending = migrations.filter((migration) => migration.version > from);
  if (pending.length === 0) return { from, to: from };
  options.beforeApply?.(from, to);
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, (options.now?.() ?? new Date()).toISOString());
    })();
  }
  return { from, to };
}
