// previewImport (PRD §5.1): detect, parse, count; write nothing; return a short-lived token.
import { describe, expect, it } from 'vitest';
import { zerodhaAdapter, type BrokerAdapter } from '@bhavbook/adapters';
import { ImportError, MAX_IMPORT_BYTES, PREVIEW_TTL_MS } from '../../src/import/index.js';
import { count, DHAN, fixtureFile, withVault, ZERODHA } from './helpers.js';

describe('previewImport', () => {
  it('previews a Zerodha tradebook with counts and coverage, writing nothing', async () => {
    await withVault(async ({ db, service }) => {
      const preview = await service.previewImport(ZERODHA, [fixtureFile('zerodha', 'tradebook', 'mine.csv')]);
      expect(preview.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(preview.files).toHaveLength(1);
      expect(preview.files[0]).toMatchObject({
        status: 'ready',
        label: 'mine.csv',
        broker: 'zerodha',
        kind: 'zerodha.tradebook',
        counts: { rows: { new: 121, duplicate: 0 }, statements: { new: 0, duplicate: 0 }, skipped: {}, errors: 0 },
        coverage: { from: '2025-09-12', to: '2026-03-23' },
        warnings: [],
        issueForecast: [],
      });
      for (const table of ['import_batch', 'raw_row', 'trade_row', 'statement_row', 'batch_row']) {
        expect(count(db, table)).toBe(0);
      }
    });
  });

  it('parses spreadsheets through the worker (Dhan tax report)', async () => {
    await withVault(async ({ service }) => {
      const preview = await service.previewImport(DHAN, [fixtureFile('dhan', 'tax_report', 'tax.xls')]);
      expect(preview.files[0]).toMatchObject({
        status: 'ready',
        kind: 'dhan.tax_report',
        counts: { rows: { new: 0 }, statements: { new: 46, duplicate: 0 } },
      });
    });
  });

  it('counts duplicates against earlier files in the same preview', async () => {
    await withVault(async ({ service }) => {
      const file = fixtureFile('zerodha', 'tradebook');
      const preview = await service.previewImport(ZERODHA, [file, file]);
      expect(preview.files.map((entry) => (entry.status === 'ready' ? entry.counts.rows : null))).toEqual([
        { new: 121, duplicate: 0 },
        { new: 0, duplicate: 121 },
      ]);
    });
  });

  it('reports a rejected kind with its message and no token', async () => {
    await withVault(async ({ service }) => {
      const preview = await service.previewImport(DHAN, [fixtureFile('dhan', 'pnl')]);
      expect(preview.files[0]).toMatchObject({ status: 'rejected', kind: 'dhan.pnl' });
      expect(preview.files[0]?.status === 'rejected' && preview.files[0].message).toMatch(/v1/);
      expect(preview.token).toBeNull();
    });
  });

  it('reports a file from another broker than the account', async () => {
    await withVault(async ({ service }) => {
      const preview = await service.previewImport(ZERODHA, [fixtureFile('dhan', 'trade_history')]);
      expect(preview.files[0]).toMatchObject({ status: 'wrong_broker', broker: 'dhan' });
    });
  });

  it('reports unrecognised and oversized files', async () => {
    await withVault(async ({ service }) => {
      const preview = await service.previewImport(ZERODHA, [
        { bytes: Buffer.from('hello,world\r\n1,2\r\n') },
        { bytes: Buffer.alloc(MAX_IMPORT_BYTES + 1, 0x41) },
      ]);
      expect(preview.files.map((file) => file.status)).toEqual(['unrecognised', 'unreadable']);
      expect(preview.files[1]).toMatchObject({ reason: 'too_large' });
    });
  });

  it('asks the user to choose when two adapters claim a file equally', async () => {
    const twin: BrokerAdapter = { ...zerodhaAdapter, broker: 'dhan' };
    await withVault(
      async ({ service }) => {
        const preview = await service.previewImport(ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
        expect(preview.files[0]).toMatchObject({ status: 'ambiguous' });
        expect(preview.files[0]?.status === 'ambiguous' && preview.files[0].candidates).toHaveLength(2);
        expect(preview.token).toBeNull();
      },
      { adapters: [zerodhaAdapter, twin] },
    );
  });

  it('only shows a bounded sample of row errors, as line + code', async () => {
    await withVault(async ({ service }) => {
      const header =
        'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';
      const bad = 'TCS,INE467B01029,2025-09-12,NSE,EQ,EQ,hold,false,5,3130.6,1,2,2025-09-12T14:50:01';
      const text = [header, ...Array.from({ length: 300 }, () => bad)].join('\r\n');
      const [file] = (await service.previewImport(ZERODHA, [{ bytes: Buffer.from(text) }])).files;
      expect(file).toMatchObject({ status: 'ready', counts: { errors: 300 } });
      expect(file?.status === 'ready' && file.errors).toHaveLength(50);
      expect(file?.status === 'ready' && file.errors[0]).toEqual({ line: 2, code: 'bad_side' });
    });
  });

  it('rejects an unknown account', async () => {
    await withVault(async ({ service }) => {
      await expect(service.previewImport('nope', [fixtureFile('zerodha', 'tradebook')])).rejects.toThrow(ImportError);
    });
  });
});

describe('preview tokens', () => {
  it('expire after 15 minutes', async () => {
    let now = new Date('2026-10-19T10:00:00Z');
    await withVault(
      async ({ service }) => {
        const preview = await service.previewImport(ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
        expect(preview.expiresAt).toBe('2026-10-19T10:15:00.000Z');
        now = new Date(now.getTime() + PREVIEW_TTL_MS + 1);
        expect(() => service.commitImport(preview.token ?? '')).toThrow(/expired/);
      },
      { now: () => now },
    );
  });

  it('are single-use and unguessable', async () => {
    await withVault(async ({ service }) => {
      const preview = await service.previewImport(ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      service.commitImport(preview.token ?? '');
      expect(() => service.commitImport(preview.token ?? '')).toThrow(ImportError);
      expect(() => service.commitImport('guess')).toThrow(ImportError);
    });
  });
});
