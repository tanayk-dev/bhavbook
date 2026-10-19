// Exercises the spreadsheet scrub paths on synthetic workbooks, so CI covers them without real exports.
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { scanContainer, scanWorkbook } from '../src/pii-scan.js';
import { scrubSpreadsheet } from '../src/xls-patch.js';

const DENY = ['Jane Q Trader'];

function biff8(rows: unknown[][]): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Equity');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }) as Buffer;
}

describe('scrubSpreadsheet (xls)', () => {
  it('patches personal values in place and keeps everything else', () => {
    const input = biff8([
      ['Tax Report - Equity', 'Name', 'Jane Q Trader'],
      ['UCC', '1100000001', 'Mobile', '9876543210'],
      ['Email ID', 'jane.trader@gmail.com'],
      ['Narration', 'Paid Clt 1100000001 bill'],
      ['TATAMOTORS', 123.45, 'INE155A01022'],
    ]);
    const { output, changes } = scrubSpreadsheet(input, 'xls', DENY);
    expect(output.length).toBe(input.length);
    expect(changes.length).toBeGreaterThan(0);
    const reread = XLSX.read(output);
    const sheet = reread.Sheets.Equity ?? {};
    const value = (ref: string): unknown => (sheet[ref] as XLSX.CellObject | undefined)?.v;
    expect(value('C1')).toBe('TEST USER    ');
    expect(value('B2')).toBe('XXXX00000X');
    expect(value('D2')).toBe('1234567890');
    expect(value('B3')).toBe('testxxxxx@example.com');
    expect(value('B4')).toBe('Paid Clt XXXX00000X bill');
    expect(value('A5')).toBe('TATAMOTORS');
    expect(value('B5')).toBe(123.45);
    expect(value('C5')).toBe('INE155A01022');
    expect([...scanWorkbook(reread, 'o', DENY), ...scanContainer(output, 'o', DENY)]).toEqual([]);
  });

  it('returns already-clean files byte for byte', () => {
    const input = biff8([
      ['Name', 'TEST USER'],
      ['x', 1],
    ]);
    expect(scrubSpreadsheet(input, 'xls', []).output.equals(input)).toBe(true);
  });

  it('fails loudly when a value cannot be patched safely', () => {
    const input = biff8([['Name', 'Jo Li']]);
    expect(() => scrubSpreadsheet(input, 'xls', [])).not.toThrow();
    expect(() => scrubSpreadsheet(biff8([['Name', 'Al']]), 'xls', [])).toThrow(/too short/);
  });
});

describe('scrubSpreadsheet (xlsx)', () => {
  it('rewrites only when needed and redacts personal document properties', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Client ID', 'AB1234']]), 'S');
    workbook.Props = { Author: 'Jane Q Trader' };
    const input = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const reread = XLSX.read(scrubSpreadsheet(input, 'xlsx', []).output);
    expect((reread.Sheets.S?.B1 as XLSX.CellObject | undefined)?.v).toBe('XX0000');
    expect(reread.Props?.Author).toMatch(/^X+$/);
  });
});
