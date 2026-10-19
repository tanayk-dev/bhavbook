import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDERS } from '../src/placeholders.js';
import { labelKey, redactText, sanitizeFileName, scrubJournalCsv, scrubWorkbook } from '../src/scrub.js';

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

  it('handles a UTF-8 BOM, quoted labels and keeps trailing fields', () => {
    const csv = Buffer.from(
      ['ï»¿Report,x', '"Name","REAL PERSON",,', 'UCC,1100000001', '', 'h'].join(CRLF),
      'latin1',
    );
    const lines = scrubJournalCsv(csv, { expectMetadata: true }).bytes.toString('latin1').split(CRLF);
    expect(lines[1]).toBe(`"Name","${PLACEHOLDERS.name}",,`);
    expect(lines[2]).toBe(`UCC,${PLACEHOLDERS.ucc}`);
  });

  it('refuses to guess when an expected metadata block is missing', () => {
    expect(() => scrubJournalCsv(journalCsv(['a,b', '1,2']), { expectMetadata: true })).toThrow(/metadata/);
  });

  it('refuses a configured column that does not exist', () => {
    expect(() =>
      scrubJournalCsv(journalCsv(['Name,X', '', 'Date,Mode', '"1","2"']), { replaceColumns: { Bank: 'TEST BANK' } }),
    ).toThrow(/column/);
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
      ['Email ID', 'some.one.else@mail.example.org'],
      ['Client ID', 'AB1234', 'PAN', 'ABCDE1234F'],
      ['Ledger', 'Paid Clt 1100000001 bill', 'TATAMOTORS', 123.45],
      ['Note', 'held by Real Person'],
    ]);
    const changes = scrubWorkbook(workbook, ['real person']);
    const sheet = workbook.Sheets.Equity;
    const value = (ref: string): unknown => sheet?.[ref]?.v;
    // Header values are replaced with same-length placeholders (binary-patchable).
    expect(value('C1')).toBe(PLACEHOLDERS.name.padEnd('REAL PERSON'.length, ' '));
    expect(value('B2')).toBe(PLACEHOLDERS.ucc);
    expect(value('D2')).toBe(PLACEHOLDERS.mobile);
    expect(value('B3')).toBe(`test${'x'.repeat('some.one.else@mail.example.org'.length - 16)}@example.com`);
    expect(value('B4')).toBe(PLACEHOLDERS.clientId);
    expect(value('D4')).toBe(PLACEHOLDERS.pan);
    expect(value('B5')).toBe(`Paid Clt ${PLACEHOLDERS.ucc} bill`);
    expect(value('C5')).toBe('TATAMOTORS');
    expect(value('D5')).toBe(123.45);
    // Text replacements keep the original length (padded with spaces) so .xls files can be byte-patched.
    expect(value('B6')).toBe(`held by ${PLACEHOLDERS.name.padEnd('Real Person'.length, ' ')}`);
    expect(changes.map((change) => change.cell).sort()).toEqual(
      ['Equity!B2', 'Equity!B3', 'Equity!B4', 'Equity!B5', 'Equity!B6', 'Equity!C1', 'Equity!D2', 'Equity!D4'].sort(),
    );
  });

  it('handles "Label:" variants, inline "Label: value" cells, hyperlinks and comments', () => {
    const workbook = workbookOf([
      ['Name :', 'Real Person'],
      ['Client Code: AB1234'],
      ['Email ID', 'test@example.com'],
    ]);
    const sheet = workbook.Sheets.Equity;
    if (!sheet) throw new Error('missing sheet');
    const emailCell = sheet.B3 as XLSX.CellObject;
    emailCell.l = { Target: 'mailto:someone.real@gmail.com', Tooltip: 'mailto:someone.real@gmail.com' };
    sheet.A3 = { t: 's', v: 'Email ID', c: [{ a: 'x', t: 'call 9876543210 or someone.real@gmail.com' }] as XLSX.Comments };
    const changes = scrubWorkbook(workbook, []);
    expect((sheet.B1 as XLSX.CellObject).v).toBe(PLACEHOLDERS.name.padEnd('Real Person'.length, ' '));
    expect((sheet.A2 as XLSX.CellObject).v).toBe(`Client Code: ${PLACEHOLDERS.clientId}`);
    expect(emailCell.l.Target).toBe(`mailto:test${'x'.repeat('someone.real@gmail.com'.length - 16)}@example.com`);
    expect((sheet.A3 as XLSX.CellObject).c?.[0]?.t).not.toContain('someone.real');
    expect(changes.every((change) => change.from.length === change.to.length)).toBe(true);
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
    ['report_20240401_x.csv', 'report_20240401_x.csv'],
  ])('sanitises %s', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });
});

describe('review follow-ups', () => {
  it('scrubs a quoted metadata value that contains a comma, keeping the line well-formed', () => {
    const csv = journalCsv(['Report,x', 'Name,"DOE, JOHN"', '', 'h']);
    const lines = scrubJournalCsv(csv, { expectMetadata: true }).bytes.toString('latin1').split(CRLF);
    expect(lines[1]).toBe(`Name,"${PLACEHOLDERS.name}"`);
  });

  it.each([
    ['Customer Name', 'name'],
    ['Account Holder :', 'name'],
    ['Name of the Client', 'name'],
    ['Mobile Number', 'mobile'],
    ['Email Address', 'email'],
    ['PAN No.', 'pan'],
    ['Client Code', 'clientId'],
    ['Unique Client Code', 'ucc'],
  ])('recognises the label %j as %s', (label, key) => {
    expect(labelKey(label)).toBe(key);
  });

  it.each(['Security Name', 'Scrip Name', 'Bank Name', 'Company Name', 'Mobile App'])(
    'does not treat the table header %j as a personal label',
    (label) => {
      expect(labelKey(label)).toBeUndefined();
    },
  );

  it('replaces an inline value by position, never touching the label', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Name: Name Person']]), 'S');
    scrubWorkbook(workbook, []);
    expect((workbook.Sheets.S?.A1 as XLSX.CellObject).v).toBe(`Name: ${PLACEHOLDERS.name.padEnd(11, ' ')}`);
  });

  it('zeroes the client part of a demat account number but keeps the public DP ID', () => {
    expect(redactText('CDSL (BOID : 1200000087654321)', [])).toBe('CDSL (BOID : 1200000000000000)');
    expect(redactText('Demat A/c No IN30000012345678', [])).toBe('Demat A/c No IN30000000000000');
    expect(redactText('order 1200000087654321', [])).toBe('order 1200000087654321');
  });

  it('redacts comment authors to the same length', () => {
    const sheet = XLSX.utils.aoa_to_sheet([['ok']]);
    (sheet.A1 as XLSX.CellObject).c = [{ a: 'Real Person', t: 'note' }] as XLSX.Comments;
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'S');
    const changes = scrubWorkbook(workbook, []);
    expect((workbook.Sheets.S?.A1 as XLSX.CellObject).c?.[0]?.a).toBe('XXXXXXXXXXX');
    expect(changes.map((change) => change.reason)).toContain('comment-author');
  });

  it('sanitises lowercase client IDs in file names', () => {
    expect(sanitizeFileName('tradebook-ab1234-EQ.csv')).toBe('tradebook-XX0000-EQ.csv');
  });
});
