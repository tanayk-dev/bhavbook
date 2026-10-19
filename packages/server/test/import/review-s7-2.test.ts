// S7-2 review follow-ups: CR-only and wide text files are bounded, rotation keeps the newest within a millisecond,
// undo checks the batch before backing up and refuses mismatched copies, and coverage merging on literal ranges.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  gapsBetween,
  ImportError,
  MAX_LINE_CHARS,
  MAX_TEXT_COLUMNS,
  MAX_TEXT_LINES,
  mergeRanges,
} from '../../src/import/index.js';
import { AUTO_BACKUP_KEEP, autoBackup, backupDir, openVault } from '../../src/vault/index.js';
import { withTempDir } from '../vault/helpers.js';
import { count, fixtureFile, importFiles, withVault, ZERODHA } from './helpers.js';

describe('text bounds (review)', () => {
  it('counts lone CR line breaks too (csv-parse accepts them as record delimiters)', async () => {
    await withVault(async ({ service }) => {
      const crOnly = Buffer.from('a,b\r'.repeat(MAX_TEXT_LINES + 2));
      const [file] = (await service.previewImport(ZERODHA, [{ bytes: crOnly }])).files;
      expect(file).toMatchObject({ status: 'unreadable', reason: 'too_large' });
    });
  });

  it('caps columns per line', async () => {
    await withVault(async ({ service }) => {
      const wide = Buffer.from(`${','.repeat(MAX_TEXT_COLUMNS)}\n`);
      const [file] = (await service.previewImport(ZERODHA, [{ bytes: wide }])).files;
      expect(file).toMatchObject({ status: 'unreadable', reason: 'too_large' });
    });
  });

  it('accepts files exactly at the limits', async () => {
    await withVault(async ({ service }) => {
      const files = [
        { bytes: Buffer.from('a\n'.repeat(MAX_TEXT_LINES)) },
        { bytes: Buffer.from(`${'x'.repeat(MAX_LINE_CHARS)}\r\n`) },
      ];
      const preview = await service.previewImport(ZERODHA, files);
      expect(preview.files.map((file) => file.status)).toEqual(['unrecognised', 'unrecognised']);
    });
  });
});

describe('auto-backup rotation order (review)', () => {
  it('keeps the newest backups when several share one millisecond', () => {
    withTempDir((dir) => {
      const vaultPath = path.join(dir, 'vault.db');
      const db = openVault(vaultPath, { appVersion: 'test' });
      try {
        const at = new Date('2026-10-19T00:00:00Z');
        const written: string[] = [];
        for (let index = 0; index < AUTO_BACKUP_KEEP + 2; index += 1) {
          written.push(
            path.basename(autoBackup(db, vaultPath, 'pre-undo', { appVersion: 'test', now: () => at })),
          );
        }
        const kept = readdirSync(backupDir(vaultPath)).filter((name) => name.includes('pre-undo'));
        expect(kept.sort()).toEqual(written.slice(2).sort());
      } finally {
        db.close();
      }
    });
  });
});

describe('undo (review)', () => {
  it('rejects an unknown batch before taking any backup', async () => {
    await withVault(({ vaultPath, service }) => {
      expect(() => service.undoImport('missing')).toThrow(ImportError);
      expect(() => readdirSync(backupDir(vaultPath))).toThrow();
    });
  });

  it('refuses a stored copy whose payload key differs from its column, changing nothing', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      const [first, second] = db
        .prepare('SELECT id FROM import_batch ORDER BY rowid')
        .pluck()
        .all() as string[];
      const victim = db
        .prepare("SELECT id, payload_json FROM batch_row WHERE batch_id = ? AND target = 'trade' LIMIT 1")
        .get(second) as { id: bigint; payload_json: string };
      const tampered = JSON.stringify({
        ...(JSON.parse(victim.payload_json) as object),
        dedupKey: 'zerodha:other',
      });
      db.prepare('UPDATE batch_row SET payload_json = ? WHERE id = ?').run(tampered, victim.id);
      expect(() => service.undoImport(first ?? '')).toThrow(ImportError);
      expect(count(db, 'import_batch')).toBe(2);
      expect(count(db, 'trade_row')).toBe(121);
    });
  });
});

describe('mergeRanges / gapsBetween on literal ranges', () => {
  it.each([
    [
      'touching across a month end',
      [
        ['2024-01-01', '2024-01-31'],
        ['2024-02-01', '2024-02-10'],
      ],
      [['2024-01-01', '2024-02-10']],
    ],
    [
      'touching across a leap day',
      [
        ['2024-02-01', '2024-02-28'],
        ['2024-02-29', '2024-03-05'],
      ],
      [['2024-02-01', '2024-03-05']],
    ],
    [
      'touching across a year end',
      [
        ['2024-12-01', '2024-12-31'],
        ['2025-01-01', '2025-01-02'],
      ],
      [['2024-12-01', '2025-01-02']],
    ],
    [
      'nested',
      [
        ['2024-01-01', '2024-12-31'],
        ['2024-03-01', '2024-03-31'],
      ],
      [['2024-01-01', '2024-12-31']],
    ],
    [
      'unsorted with a one-day gap',
      [
        ['2024-03-03', '2024-03-04'],
        ['2024-03-01', '2024-03-01'],
      ],
      [
        ['2024-03-01', '2024-03-01'],
        ['2024-03-03', '2024-03-04'],
      ],
    ],
  ])('%s', (_label, input, expected) => {
    const toRanges = (pairs: string[][]): { from: string; to: string }[] =>
      pairs.map(([from = '', to = '']) => ({ from, to }));
    expect(mergeRanges(toRanges(input))).toEqual(toRanges(expected));
  });

  it('reports calendar-day gaps, weekends included', () => {
    const ranges = [
      { from: '2026-10-12', to: '2026-10-16' },
      { from: '2026-10-19', to: '2026-10-23' },
    ];
    expect(gapsBetween(ranges)).toEqual([{ from: '2026-10-17', to: '2026-10-18' }]);
    expect(gapsBetween([])).toEqual([]);
  });
});
