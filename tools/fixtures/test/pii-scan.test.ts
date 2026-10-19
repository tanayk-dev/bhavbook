import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { loadDenylist, mask, scanContainer, scanPaths, scanText, scanWorkbook } from '../src/pii-scan.js';

function withTempDir(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), 'pii-scan-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function xlsxBuffer(workbook: XLSX.WorkBook, bookType: 'xlsx' | 'biff8' = 'xlsx'): Buffer {
  return XLSX.write(workbook, { type: 'buffer', bookType }) as Buffer;
}

describe('scanText', () => {
  it.each([
    ['PAN ABCDE1234F here', 'pan'],
    ['mail me at real.person@gmail.com', 'email'],
    ['Mobile,9876543210', 'mobile'],
    ['call +919876543210', 'mobile'],
    ['Mobile,97XXXXXX91', 'masked-mobile'],
    ['Paid to Clt 11000001X via bank', 'client-ref'],
    ['Clt_AB12C', 'client-ref'],
    ['Client ID,AB1234', 'zerodha-client-id'],
    ['tradebook_AB1234_2024.csv', 'zerodha-client-id'],
    ['pan_ABCDE1234F.csv', 'pan'],
    ['call +91 98765 43210', 'mobile'],
    ['call 98765-43210', 'mobile'],
    ['TRANSFER FROM CDSL (BOID : 1200000087654321', 'demat-account'],
    ['Demat Account No. IN30000012345678', 'demat-account'],
    ['paid to someone@okaxis', 'upi-id'],
    ['refund to a.person@ybl', 'upi-id'],
    ['Bank A/c No: 123456789012', 'bank-account'],
    ['IFSC,HDFC0001234', 'ifsc'],
    ['Aadhaar 2345 6789 0123', 'aadhaar'],
    ['DOB: 01/02/1990', 'date-of-birth'],
    ['Pincode 411001', 'pin-code'],
  ])('flags %j as %s', (text, kind) => {
    expect(scanText(text, 'f.csv', []).map((finding) => finding.kind)).toEqual([kind]);
  });

  it.each([
    'PAN,XXXXX0000X',
    'Email ID,test@example.com',
    'Email ID,testxxxx@example.com',
    'write to help@dhan.co or support@zerodha.com',
    'Mobile,1234567890',
    'Narration: Clt XXXX00000X bill',
    'Client ID,XX0000',
    'TATATECH,INE142M01025,2025-09-12,NSE,EQ,EQ,sell,false,10.000000,700.599976,606003128,1300000051263385',
    'Net P&L,9876543210.50',
    '"JV1234567890","BP1234567890"',
    'TRANSFER FROM CDSL (BOID : 1200000000000000',
    'order 1200000051263385 filled',
    'Demat Account charges',
    'Money added to your Trading Account',
    'Bank A/c No: 000000000000',
    'IFSC,XXXX0XXXXXX',
    'bill 12649302 dated 18 Sep 2024',
  ])('allows %j', (text) => {
    expect(scanText(text, 'f.csv', [])).toEqual([]);
  });

  it('flags denylisted terms case-insensitively', () => {
    const findings = scanText('Name,Jane Q Trader', 'f.csv', ['jane q trader']);
    expect(findings.map((finding) => finding.kind)).toEqual(['denylist']);
  });

  it('ignores denylist terms shorter than 3 characters', () => {
    expect(scanText('ab', 'f.csv', ['ab'])).toEqual([]);
  });

  it('masks the matched value in findings so logs never carry the full value', () => {
    const [finding] = scanText('real.person@gmail.com', 'f.csv', []);
    expect(finding?.sample).toBe('re***');
    expect(finding?.location).toBe('f.csv:1');
  });

  it('reports 1-based line numbers, including for lone CR line breaks', () => {
    expect(scanText('ok\nok\nPAN ABCDE1234F', 'f.csv', [])[0]?.location).toBe('f.csv:3');
    expect(scanText('ok\rPAN ABCDE1234F', 'f.csv', [])[0]?.location).toBe('f.csv:2');
  });

  it('skips markup-prone detectors in raw mode (cell refs such as AB1234 in XML)', () => {
    expect(scanText('<c r="AB1234">', 'x.xml', [], { raw: true })).toEqual([]);
  });
});

describe('mask', () => {
  it('hides short values entirely', () => {
    expect(mask('ab')).toBe('***');
    expect(mask('abcd')).toBe('***');
    expect(mask('abcde')).toBe('ab***');
  });
});

describe('scanWorkbook', () => {
  it('scans string and numeric cells with sheet and cell locations', () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Name', 'TEST USER'],
      ['Mobile', 9876543210],
      ['PAN', 'XXXXX0000X'],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Equity');
    expect(scanWorkbook(workbook, 'r.xls', [])).toEqual([
      { kind: 'mobile', location: 'r.xls!sheet1!B2', sample: '98***' },
    ]);
  });

  it('flags personal document properties such as LastAuthor, but not redacted ones', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['ok']]), 'S');
    workbook.Props = { Author: 'XXXXX', LastAuthor: 'Real Person' };
    expect(scanWorkbook(workbook, 'r.xls', [])).toEqual([
      { kind: 'doc-property', location: 'r.xls#LastAuthor', sample: 'Re***' },
    ]);
  });

  it('flags comment authors and scans custom properties', () => {
    const sheet = XLSX.utils.aoa_to_sheet([['ok']]);
    (sheet.A1 as XLSX.CellObject).c = [{ a: 'Real Person', t: 'note' }] as XLSX.Comments;
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Secret Sheet Name');
    workbook.Custprops = { Owner: 'real.person@gmail.com' };
    const findings = scanWorkbook(workbook, 'r.xls', []);
    expect(findings.map((finding) => finding.kind).sort()).toEqual(['comment-author', 'email']);
    expect(findings.every((finding) => !finding.location.includes('Secret Sheet Name'))).toBe(true);
  });

  it('scans hyperlink targets', () => {
    const sheet = XLSX.utils.aoa_to_sheet([['Email', 'test@example.com']]);
    (sheet.B1 as XLSX.CellObject).l = { Target: 'mailto:real.person@gmail.com' };
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'S');
    expect(scanWorkbook(workbook, 'r.xls', [])).toEqual([
      { kind: 'email', location: 'r.xls!sheet1!B1#link', sample: 're***' },
    ]);
  });
});

describe('scanContainer', () => {
  it('finds personal data in xlsx parts that cell values do not show (comments)', () => {
    const sheet = XLSX.utils.aoa_to_sheet([['ok']]);
    (sheet.A1 as XLSX.CellObject).c = [{ a: 'author', t: 'ping real.person@gmail.com' }] as XLSX.Comments;
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'S');
    const kinds = scanContainer(xlsxBuffer(workbook), 'r.xlsx', []).map((finding) => finding.kind);
    expect(kinds).toContain('email');
  });

  it('finds denylist terms inside legacy .xls OLE streams', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['held by Jane Q Trader']]), 'S');
    const kinds = scanContainer(xlsxBuffer(workbook, 'biff8'), 'r.xls', ['Jane Q Trader']).map((finding) => finding.kind);
    expect(kinds).toContain('denylist');
  });
});

describe('scanPaths', () => {
  it('walks directories: file names, text files, spreadsheets, and flags unsupported types', () => {
    withTempDir((root) => {
      mkdirSync(path.join(root, 'nested'));
      writeFileSync(path.join(root, 'clean.csv'), 'Name,TEST USER\r\nUCC,XXXX00000X');
      writeFileSync(path.join(root, 'nested', 'leak.csv'), 'Email ID,real.person@gmail.com');
      writeFileSync(path.join(root, 'tradebook-AB1234-EQ.bin'), 'binary');
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['PAN', 'ABCDE1234F']]), 'S');
      writeFileSync(path.join(root, 'r.xlsx'), xlsxBuffer(workbook));
      const findings = scanPaths([root], []);
      expect(new Set(findings.map((finding) => finding.kind))).toEqual(
        new Set(['email', 'pan', 'unsupported-file', 'zerodha-client-id']),
      );
      const nameFinding = findings.find((finding) => finding.kind === 'zerodha-client-id');
      expect(nameFinding?.location).not.toContain('AB1234');
    });
  });

  it('decodes UTF-16 text files (BOM)', () => {
    withTempDir((root) => {
      const text = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Email,real.person@gmail.com', 'utf16le')]);
      writeFileSync(path.join(root, 'utf16.csv'), text);
      expect(scanPaths([root], []).map((finding) => finding.kind)).toContain('email');
    });
  });

  it('fails on a missing path or an empty scan instead of reporting OK', () => {
    withTempDir((root) => {
      expect(() => scanPaths([path.join(root, 'missing')], [])).toThrow(/does not exist/);
      expect(() => scanPaths([root], [])).toThrow(/no files/);
      expect(() => scanPaths([], [])).toThrow(/at least one/);
    });
  });
});

describe('loadDenylist', () => {
  it('reads BHAVBOOK_PII_DENYLIST, ignoring blanks and comments', () => {
    withTempDir((root) => {
      const previous = process.env.BHAVBOOK_PII_DENYLIST;
      try {
        const file = path.join(root, 'deny');
        writeFileSync(file, '# my identifiers\r\nJane Q Trader\r\n\r\n  AB1234  \n');
        process.env.BHAVBOOK_PII_DENYLIST = file;
        expect(loadDenylist()).toEqual(['Jane Q Trader', 'AB1234']);
        process.env.BHAVBOOK_PII_DENYLIST = path.join(root, 'absent');
        expect(loadDenylist()).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env.BHAVBOOK_PII_DENYLIST;
        else process.env.BHAVBOOK_PII_DENYLIST = previous;
      }
    });
  });
});
