// Deferred S7-1 review items: text files are bounded before parsing on the main thread, and auto-backups rotate
// per reason so frequent imports can't push out other restore points.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_LINE_CHARS, MAX_TEXT_LINES } from '../../src/import/index.js';
import { AUTO_BACKUP_KEEP, autoBackup, backupDir, openVault } from '../../src/vault/index.js';
import { withTempDir } from '../vault/helpers.js';
import { withVault, ZERODHA } from './helpers.js';

describe('text bounds', () => {
  it('refuses text with too many lines or an overlong line, before parsing', async () => {
    await withVault(async ({ service }) => {
      const manyLines = Buffer.from('a\n'.repeat(MAX_TEXT_LINES + 1));
      const longLine = Buffer.from(`symbol,${'x'.repeat(MAX_LINE_CHARS)}\n`);
      const preview = await service.previewImport(ZERODHA, [{ bytes: manyLines }, { bytes: longLine }]);
      expect(preview.files).toMatchObject([
        { status: 'unreadable', reason: 'too_large' },
        { status: 'unreadable', reason: 'too_large' },
      ]);
    });
  });
});

describe('auto-backup rotation', () => {
  it('keeps the newest AUTO_BACKUP_KEEP backups per reason, and every pre-migration backup', () => {
    withTempDir((dir) => {
      const vaultPath = path.join(dir, 'vault.db');
      const db = openVault(vaultPath, { appVersion: 'test' });
      try {
        let tick = Date.parse('2026-10-19T00:00:00Z');
        const backup = (reason: 'pre-import' | 'pre-restore' | 'pre-migration'): void => {
          tick += 1_000;
          const at = new Date(tick);
          autoBackup(db, vaultPath, reason, { appVersion: 'test', now: () => at });
        };
        for (let index = 0; index < 2; index += 1) backup('pre-restore');
        for (let index = 0; index < 2; index += 1) backup('pre-migration');
        for (let index = 0; index < AUTO_BACKUP_KEEP + 3; index += 1) backup('pre-import');
        const names = readdirSync(backupDir(vaultPath));
        expect(names.filter((name) => name.includes('-pre-import'))).toHaveLength(AUTO_BACKUP_KEEP);
        expect(names.filter((name) => name.includes('-pre-restore'))).toHaveLength(2);
        expect(names.filter((name) => name.includes('-pre-migration'))).toHaveLength(2);
      } finally {
        db.close();
      }
    });
  });
});
