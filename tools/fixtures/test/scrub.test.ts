import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDERS } from '../src/placeholders.js';
import { sanitizeFileName, scrubJournalCsv, scrubWorkbook } from '../src/scrub.js';

const CRLF = '\r\n';

function journalCsv(lines: string[]): Buffer {
  return Buffer.from(lines.join(CRLF), 'latin1');
}

describe('scrubJournalCsv', () => {
  const original = journalCsv([
    'PnL report,From 01-04-2024 to 31-03-2025',
    'Name,REAL PERSON',
    'UCC,1100000001',
    'Mobile,9876543210',
    'Email ID,real.person@gmail.com',
    '',
    'Scrip Name,Buy Qty.',
    '"Sterling & Wilson Renewable Energy","20"',
    '',
    'Net P&L,-7219.12',
    '',
    'NOTE : This sheet was downloaded at 10/18/2026 10:08 PM',
  ]);

  it('replaces only the metadata values and keeps every other byte', () => {
    const { bytes, replaced } = scrubJournalCsv(original, {});
    const lines = bytes.toString('latin1').split(CRLF);
    expect(lines.slice(1, 5)).toEqual([
      `Name,${PLACEHOLDERS.name}`,
      `UCC,${PLACEHOLDERS.ucc}`,
      `Mobile,${PLACEHOLDERS.mobile}`,
      `Email ID,${PLACEHOLDERS.email}`,
    ]);
    const originalLines = original.toString('latin1').split(CRLF);
    expect([lines[0], ...lines.slice(5)]).toEqual([originalLines[0], ...originalLines.slice(5)]);
    expect(replaced).toEqual(['Name', 'UCC', 'Mobile', 'Email ID']);
  });

  it('preserves CRLF endings and the missing trailing newline', () => {
    const { bytes } = scrubJournalCsv(original, {});
    expect(bytes.subarray(-2).toString('latin1')).toBe('PM');
    expect(bytes.toString('latin1').split('\n').length).toBe(original.toString('latin1').split('\n').length);
  });

  it('is idempotent', () => {
    const once = scrubJournalCsv(original, {}).bytes;
    expect(scrubJournalCsv(once, {}).bytes.equals(once)).toBe(true);
  });

  it('replaces a named data column (e.g. bank) in quoted rows', () => {
    const funds = journalCsv([
      'Fund Summary,From 01-04-2024 to 31-03-2025',
      'Name,REAL PERSON',
      '',
      'Date & Time,Transaction Type,Bank,Mode,Amount,Status',
      '"01 Apr 2024","Deposit","Some Bank of India","UPI","5000.00","Success"',
      '',
      'NOTE : x',
    ]);
    const { bytes, replaced } = scrubJournalCsv(funds, { replaceColumns: { Bank: PLACEHOLDERS.bank } });
    const lines = bytes.toString('latin1').split(CRLF);
    expect(lines[4]).toBe(`"01 Apr 2024","Deposit","${PLACEHOLDERS.bank}","UPI","5000.00","Success"`);
    expect(replaced).toContain('Bank');
  });

  it('leaves a file without metadata untouched', () => {
    const trades = journalCsv(['Date,Time,Name', '2026-10-15,11:36:25,Marine Electricals']);
    const { bytes, replaced } = scrubJournalCsv(trades, {});
    expect(bytes.equals(trades)).toBe(true);
    expect(replaced).toEqual([]);
  });
});

describe('scrubWorkbook', () => {
  function workbookOf(rows: unknown[][]): XLSX.WorkBook {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Equity');
    return workbook;
  }

  it('replaces values that follow header labels, plus Clt narrations and denylist terms', () => {
    const workbook = workbookOf([
      ['Tax Report - Equity', 'Name', 'REAL PERSON'],
      ['UCC', '1100000001', 'Mobile', '97XXXXXX91'],
      ['Email ID', 'reXXXXXX92@gmail.com'],
      ['Client ID', 'AB1234', 'PAN', 'ABCDE1234F'],
      ['Ledger', 'Paid Clt 1100000001 bill', 'TATAMOTORS', 123.45],
      ['Note', 'held by Real Person'],
    ]);
    const changes = scrubWorkbook(workbook, ['real person']);
    const sheet = workbook.Sheets.Equity;
    const value = (ref: string): unknown => sheet?.[ref]?.v;
    expect(value('C1')).toBe(PLACEHOLDERS.name);
    expect(value('B2')).toBe(PLACEHOLDERS.ucc);
    expect(value('D2')).toBe(PLACEHOLDERS.mobile);
    expect(value('B3')).toBe(PLACEHOLDERS.email);
    expect(value('B4')).toBe(PLACEHOLDERS.clientId);
    expect(value('D4')).toBe(PLACEHOLDERS.pan);
    expect(value('B5')).toBe(`Paid Clt ${PLACEHOLDERS.ucc} bill`);
    expect(value('C5')).toBe('TATAMOTORS');
    expect(value('D5')).toBe(123.45);
    expect(value('B6')).toBe(`held by ${PLACEHOLDERS.name}`);
    expect(changes.map((change) => change.cell).sort()).toEqual(
      ['Equity!B2', 'Equity!B3', 'Equity!B4', 'Equity!B5', 'Equity!B6', 'Equity!C1', 'Equity!D2', 'Equity!D4'].sort(),
    );
  });

  it('makes no changes to an already scrubbed workbook', () => {
    const workbook = workbookOf([
      ['Client ID', PLACEHOLDERS.clientId],
      ['PAN', PLACEHOLDERS.pan],
    ]);
    expect(scrubWorkbook(workbook, [])).toEqual([]);
  });
});

describe('sanitizeFileName', () => {
  it.each([
    ['TRADE_HISTORY_CSV_1100000001_2021-01-01_2026-10-18_0_.csv', 'TRADE_HISTORY_CSV_XXXX00000X_2021-01-01_2026-10-18_0_.csv'],
    ['tradebook-AB1234-EQ.csv', 'tradebook-XX0000-EQ.csv'],
    ['taxpnl-XXX000-2024_2025-Q1-Q4.xlsx', 'taxpnl-XX0000-2024_2025-Q1-Q4.xlsx'],
    ['Dhan_P&L_01-04-2024_31-03-2025.csv', 'Dhan_P&L_01-04-2024_31-03-2025.csv'],
  ])('sanitises %s', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });
});
