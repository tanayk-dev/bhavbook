// Startup recovery (S4 review), run while holding the vault lock. restoreBackup's swap moves the live vault to
// `.<vault>.old-<hex>.tmp` and then renames the rebuilt file into place; a crash between the two leaves no vault.
// If the vault is missing, the newest old copy (and its sidecars) is moved back. Every other temp file a restore
// or backup leaves behind is deleted.
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { backupDir } from './backup.js';

export interface RecoveryResult {
  readonly restoredOldVault: boolean;
  readonly removedTempFiles: number;
}

const SIDECARS = ['', '-wal', '-shm', '-journal'] as const;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Temp files that backup.ts's tempPath() creates next to `target` (any tag), with optional SQLite sidecars. */
function tempPattern(base: string, tags: string): RegExp {
  return new RegExp(`^\\.${base}\\.(${tags})-([0-9a-f]{12})\\.tmp(-wal|-shm|-journal)?$`);
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function newestOldVault(dir: string, names: readonly string[], pattern: RegExp): string | null {
  const candidates = names
    .filter((name) => {
      const match = pattern.exec(name);
      return match?.[1] === 'old' && match[3] === undefined;
    })
    .map((name) => path.join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

export function recoverInterruptedRestore(vaultPath: string): RecoveryResult {
  const dir = path.dirname(vaultPath);
  const pattern = tempPattern(escapeRegExp(path.basename(vaultPath)), 'old|restore|rebuilt|write');
  let restoredOldVault = false;
  if (!existsSync(vaultPath)) {
    const old = newestOldVault(dir, listDir(dir), pattern);
    if (old !== null) {
      for (const suffix of SIDECARS) {
        if (existsSync(`${old}${suffix}`)) renameSync(`${old}${suffix}`, `${vaultPath}${suffix}`);
      }
      restoredOldVault = true;
    }
  }

  let removedTempFiles = 0;
  const remove = (file: string): void => {
    rmSync(file, { force: true });
    removedTempFiles += 1;
  };
  for (const name of listDir(dir)) if (pattern.test(name)) remove(path.join(dir, name));
  const backups = backupDir(vaultPath);
  const backupTemps = tempPattern('[^/\\\\]+', 'snapshot|write');
  for (const name of listDir(backups)) if (backupTemps.test(name)) remove(path.join(backups, name));
  return { restoredOldVault, removedTempFiles };
}
