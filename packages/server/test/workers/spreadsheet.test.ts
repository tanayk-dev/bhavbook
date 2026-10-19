import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { readSpreadsheet, SpreadsheetError } from '../../src/workers/spreadsheet.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'adapters',
  'fixtures',
);

function workbook(rows: unknown[][], bookType: 'xlsx' | 'biff8' = 'xlsx'): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Equity');
  return XLSX.write(book, { type: 'buffer', bookType }) as Buffer;
}

describe('readSpreadsheet', () => {
  it.each(['xlsx', 'biff8'] as const)('reads %s into plain sheet data', async (bookType) => {
    const sheets = await readSpreadsheet(
      workbook(
        [
          ['Symbol', 'Qty'],
          ['TCS', 5],
          ['INFY', null],
        ],
        bookType,
      ),
    );
    expect(sheets).toEqual([
      {
        name: 'Equity',
        rows: [
          ['Symbol', 'Qty'],
          ['TCS', 5],
          ['INFY', null],
        ],
      },
    ]);
  });

  it('returns cached formula results and never the formula itself', async () => {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([[2, 3, null]]);
    sheet.C1 = { t: 'n', v: 5, f: 'A1+B1' };
    XLSX.utils.book_append_sheet(book, sheet, 'S');
    const sheets = await readSpreadsheet(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    expect(sheets[0]?.rows).toEqual([[2, 3, 5]]);
  });

  it('reads the real-format fixtures (Dhan .xls with 8 sheets, Zerodha tax P&L .xlsx with 11)', async () => {
    const dhan = await readSpreadsheet(
      readFileSync(path.join(FIXTURES, 'dhan', 'tax_report', 'tax-pnl-report.xls')),
    );
    expect(dhan.map((sheet) => sheet.name)).toContain('Equity');
    expect(dhan).toHaveLength(8);
    const zerodha = await readSpreadsheet(
      readFileSync(path.join(FIXTURES, 'zerodha', 'tax_pnl', 'taxpnl-XX0000-2024_2025-Q1-Q4.xlsx')),
    );
    expect(zerodha).toHaveLength(11);
  });

  it('rejects files over the size limit before parsing', async () => {
    await expect(readSpreadsheet(Buffer.alloc(2048), { maxBytes: 1024 })).rejects.toThrow(/too large/);
  });

  it('rejects workbooks with too many rows', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => [index]);
    await expect(readSpreadsheet(workbook(rows), { maxRows: 10 })).rejects.toThrow(/too many rows/);
  });

  it('rejects files that are not spreadsheets', async () => {
    await expect(readSpreadsheet(Buffer.from('PK\u0003\u0004 not really a zip at all'))).rejects.toThrow(
      SpreadsheetError,
    );
  });

  it('kills a parse that runs past the time limit', async () => {
    const rows = Array.from({ length: 20_000 }, (_, index) => [index, `row ${String(index)}`, index * 2]);
    await expect(readSpreadsheet(workbook(rows), { timeoutMs: 1 })).rejects.toThrow(/timed out/);
  });

  it('never echoes file contents in error messages', async () => {
    try {
      await readSpreadsheet(Buffer.from('Name,Real Person,secret-value'));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SpreadsheetError);
      expect((error as Error).message).not.toContain('Real Person');
    }
  });
});
