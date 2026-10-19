// Startup recovery (S4 review): undo a restore that crashed mid-swap, and delete stale restore temp files.
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupDir, recoverInterruptedRestore } from '../../src/vault/index.js';
import { withTempDir } from './helpers.js';

const HEX = 'a1b2c3d4e5f6';

describe('recoverInterruptedRestore', () => {
  it('moves the old vault and its sidecars back when the vault file is missing', () => {
    withTempDir((dir) => {
      const vault = path.join(dir, 'vault.db');
      const old = path.join(dir, `.vault.db.old-${HEX}.tmp`);
      writeFileSync(old, 'main');
      writeFileSync(`${old}-wal`, 'wal');
      expect(recoverInterruptedRestore(vault)).toEqual({ restoredOldVault: true, removedTempFiles: 0 });
      expect(readFileSync(vault, 'utf8')).toBe('main');
      expect(readFileSync(`${vault}-wal`, 'utf8')).toBe('wal');
      expect(existsSync(old)).toBe(false);
    });
  });

  it('picks the newest old vault when several exist, and deletes the rest', () => {
    withTempDir((dir) => {
      const vault = path.join(dir, 'vault.db');
      const older = path.join(dir, '.vault.db.old-000000000001.tmp');
      const newer = path.join(dir, '.vault.db.old-000000000002.tmp');
      writeFileSync(older, 'older');
      writeFileSync(newer, 'newer');
      const past = new Date(Date.now() - 60_000);
      utimesSync(older, past, past);
      expect(recoverInterruptedRestore(vault).restoredOldVault).toBe(true);
      expect(readFileSync(vault, 'utf8')).toBe('newer');
      expect(readdirSync(dir)).toEqual(['vault.db']);
    });
  });

  it('keeps the live vault and deletes leftovers of a finished or failed restore', () => {
    withTempDir((dir) => {
      const vault = path.join(dir, 'vault.db');
      writeFileSync(vault, 'live');
      for (const name of [
        `.vault.db.old-${HEX}.tmp`,
        `.vault.db.restore-${HEX}.tmp`,
        `.vault.db.restore-${HEX}.tmp-wal`,
        `.vault.db.rebuilt-${HEX}.tmp`,
        `.vault.db.write-${HEX}.tmp`,
      ]) {
        writeFileSync(path.join(dir, name), 'x');
      }
      mkdirSync(backupDir(vault));
      writeFileSync(path.join(backupDir(vault), `.auto-x.bhav.snapshot-${HEX}.tmp`), 'x');
      writeFileSync(path.join(backupDir(vault), 'auto-x.bhav'), 'keep');
      expect(recoverInterruptedRestore(vault)).toEqual({ restoredOldVault: false, removedTempFiles: 6 });
      expect(readdirSync(dir).sort()).toEqual(['vault.db', 'vault.db.backups']);
      expect(readdirSync(backupDir(vault))).toEqual(['auto-x.bhav']);
      expect(readFileSync(vault, 'utf8')).toBe('live');
    });
  });

  it('leaves unrelated files alone, including temp files of another vault in the same folder', () => {
    withTempDir((dir) => {
      const vault = path.join(dir, 'vault.db');
      writeFileSync(vault, 'live');
      for (const name of [`.other.db.old-${HEX}.tmp`, 'notes.txt', `.vault.db.old-${HEX}.tmp.bak`, `.vault.db.old-XYZ.tmp`]) {
        writeFileSync(path.join(dir, name), 'x');
      }
      expect(recoverInterruptedRestore(vault).removedTempFiles).toBe(0);
      expect(readdirSync(dir)).toHaveLength(5);
    });
  });

  it('does nothing for a brand-new vault location', () => {
    withTempDir((dir) => {
      expect(recoverInterruptedRestore(path.join(dir, 'vault.db'))).toEqual({
        restoredOldVault: false,
        removedTempFiles: 0,
      });
    });
  });
});
