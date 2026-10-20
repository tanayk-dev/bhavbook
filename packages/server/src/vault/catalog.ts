// The backups a person can see and act on (S13a-3b-2): the files in `<vault>.backups/` that BhavBook named itself.
// Manual backups (`backup-<UTC>-manual.bhav`) are never rotated; automatic ones (`auto-<UTC>-<reason>.bhav`) are
// rotated per reason by autoBackup. A name is only ever resolved by matching this pattern, so a request can never
// reach a file outside the backup directory. Raw copies of an unreadable vault (`raw-*.db`) are not listed.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { backupDir, createBackup, ensureBackupDir, uniqueBackupPath, type BackupOptions } from './backup.js';

const BACKUP_NAME =
  /^(auto|backup)-(\d{8})T(\d{2})(\d{2})(\d{2})(\d{3})Z-([a-z]+(?:-[a-z]+)*?)(?:-(\d+))?\.bhav$/;

export interface BackupEntry {
  /** The file name, which is also the backup's id. */
  readonly name: string;
  readonly kind: 'manual' | 'auto';
  /** Why an automatic backup was taken (`pre-import`, `pre-restore`, ...), or `manual`. */
  readonly reason: string;
  /** UTC, ISO-8601. */
  readonly createdAt: string;
  readonly bytes: number;
}

function parseName(name: string): Omit<BackupEntry, 'bytes'> | null {
  const match = BACKUP_NAME.exec(name);
  if (match === null) return null;
  const [, prefix, date = '', hours, minutes, seconds, millis, reason = ''] = match;
  const createdAt = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${hours ?? ''}:${minutes ?? ''}:${seconds ?? ''}.${millis ?? ''}Z`;
  return { name, kind: prefix === 'backup' ? 'manual' : 'auto', reason, createdAt };
}

/** Every backup BhavBook made for this vault, newest first. */
export function listBackups(vaultPath: string): BackupEntry[] {
  const dir = backupDir(vaultPath);
  if (!existsSync(dir)) return [];
  const entries: BackupEntry[] = [];
  for (const name of readdirSync(dir)) {
    const parsed = parseName(name);
    if (parsed === null) continue;
    const stats = statSync(path.join(dir, name), { throwIfNoEntry: false });
    if (stats?.isFile() === true) entries.push({ ...parsed, bytes: stats.size });
  }
  // Same millisecond: the bare name is the first, then -2, -3 (string order would put -10 before -2).
  const counter = (name: string) => Number.parseInt(BACKUP_NAME.exec(name)?.[8] ?? '1', 10);
  return entries.sort((a, b) =>
    a.createdAt === b.createdAt ? counter(b.name) - counter(a.name) : a.createdAt < b.createdAt ? 1 : -1,
  );
}

/** The path of a listed backup, or null when the name is not one of ours or the file is gone. */
export function backupPath(vaultPath: string, name: string): string | null {
  if (parseName(name) === null) return null;
  const file = path.join(backupDir(vaultPath), name);
  return statSync(file, { throwIfNoEntry: false })?.isFile() === true ? file : null;
}

/** Writes a manual backup into the backup directory; it is never rotated away. */
export function manualBackup(db: Database.Database, vaultPath: string, options: BackupOptions): BackupEntry {
  const dir = ensureBackupDir(vaultPath);
  const target = uniqueBackupPath(dir, 'backup', options.now?.() ?? new Date(), 'manual', 'bhav');
  const { bytes } = createBackup(db, target, options);
  const parsed = parseName(path.basename(target));
  if (parsed === null) throw new Error('manual backup name does not match the catalog pattern');
  return { ...parsed, bytes };
}
