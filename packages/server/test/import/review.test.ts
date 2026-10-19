// S7-1 review follow-ups: coverage-based wrong-account overlap, counts as committed, retryable failed commits,
// bounded previews, lean batch copies.
import { rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ImportError, MAX_PREVIEW_BYTES, MAX_PREVIEW_FILES, MAX_LABEL_CHARS } from '../../src/import/index.js';
import { backupDir } from '../../src/vault/index.js';
import { count, csvWindow, fixtureFile, importFiles, withVault, ZERODHA } from './helpers.js';

describe('wrong-account guard uses the imported coverage, not the span of all trades', () => {
  it('does not warn when a file fills a gap between earlier imports', async () => {
    await withVault(async ({ service }) => {
      await importFiles(service, ZERODHA, [csvWindow('zerodha', 'tradebook', 0, 30)]);
      await importFiles(service, ZERODHA, [csvWindow('zerodha', 'tradebook', 100, 121)]);
      const [file] = (await service.previewImport(ZERODHA, [csvWindow('zerodha', 'tradebook', 40, 90)])).files;
      expect(file).toMatchObject({ status: 'ready', warnings: [] });
    });
  });
});

describe('import_batch.counts_json', () => {
  it('records what the commit inserted, not the preview-time estimate', async () => {
    await withVault(async ({ db, service }) => {
      const first = await service.previewImport(ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      const second = await service.previewImport(ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      service.commitImport(first.token ?? '');
      service.commitImport(second.token ?? '');
      const counts = (db.prepare('SELECT counts_json FROM import_batch ORDER BY rowid').pluck().all() as string[]).map(
        (text) => JSON.parse(text) as { rows: { new: number; duplicate: number } },
      );
      expect(counts.map((entry) => entry.rows)).toEqual([
        { new: 121, duplicate: 0 },
        { new: 0, duplicate: 121 },
      ]);
    });
  });
});

describe('failed commits', () => {
  it('keep the preview so the commit can be retried', async () => {
    await withVault(async ({ db, service }) => {
      const preview = await service.previewImport(ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON main.trade_row BEGIN SELECT RAISE(ABORT, 'boom'); END;");
      expect(() => service.commitImport(preview.token ?? '')).toThrow(ImportError);
      db.exec('DROP TRIGGER temp.boom');
      expect(service.commitImport(preview.token ?? '').batches[0]?.inserted.rows).toBe(121);
    });
  });

  it('report a failed pre-import backup as a fixed ImportError and write nothing', async () => {
    await withVault(async ({ db, vaultPath, service }) => {
      const preview = await service.previewImport(ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      writeFileSync(backupDir(vaultPath), 'not a directory');
      try {
        service.commitImport(preview.token ?? '');
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ImportError);
        expect((error as Error).message).not.toContain(vaultPath);
      }
      expect(count(db, 'import_batch')).toBe(0);
      rmSync(backupDir(vaultPath));
      expect(service.commitImport(preview.token ?? '').batches).toHaveLength(1);
    });
  });
});

describe('preview bounds', () => {
  it('refuses more than MAX_PREVIEW_FILES files', async () => {
    await withVault(async ({ service }) => {
      const files = Array.from({ length: MAX_PREVIEW_FILES + 1 }, () => fixtureFile('zerodha', 'tradebook'));
      await expect(service.previewImport(ZERODHA, files)).rejects.toThrow(ImportError);
    });
  });

  it('refuses a preview whose files add up to more than MAX_PREVIEW_BYTES', async () => {
    await withVault(async ({ service }) => {
      const big = { bytes: Buffer.alloc(Math.ceil(MAX_PREVIEW_BYTES / 4) + 1, 0x41) };
      await expect(service.previewImport(ZERODHA, [big, big, big, big])).rejects.toThrow(ImportError);
    });
  });

  it('truncates long labels', async () => {
    await withVault(async ({ service }) => {
      const preview = await service.previewImport(ZERODHA, [
        { ...fixtureFile('zerodha', 'tradebook'), name: 'x'.repeat(MAX_LABEL_CHARS + 50) },
      ]);
      expect(preview.files[0]?.label).toHaveLength(MAX_LABEL_CHARS);
    });
  });
});

describe('batch_row payloads', () => {
  it('keep the raw line number but not a second copy of the raw text', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      const payload = JSON.parse(
        db.prepare("SELECT payload_json FROM batch_row WHERE target = 'trade' LIMIT 1").pluck().get() as string,
      ) as { raw: Record<string, unknown>; dedupKey: string };
      expect(payload.raw).toEqual({ line: expect.any(Number) as number });
      expect(payload.dedupKey).toMatch(/^zerodha:/);
    });
  });
});
