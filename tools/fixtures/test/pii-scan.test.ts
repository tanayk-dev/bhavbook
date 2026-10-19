import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { scanText, scanWorkbook } from '../src/pii-scan.js';

describe('scanText', () => {
  it.each([
    ['PAN ABCDE1234F here', 'pan'],
    ['mail me at real.person@gmail.com', 'email'],
    ['Mobile,9876543210', 'mobile'],
    ['Mobile,97XXXXXX91', 'masked-mobile'],
    ['Paid to Clt AB12345 via bank', 'client-ref'],
    ['Client ID,AB1234', 'zerodha-client-id'],
  ])('flags %j as %s', (text, kind) => {
    expect(scanText(text, 'f.csv', []).map((finding) => finding.kind)).toEqual([kind]);
  });

  it.each([
    'PAN,XXXXX0000X',
    'Email ID,test@example.com',
    'write to help@dhan.co or support@zerodha.com',
    'Mobile,1234567890',
    'Narration: Clt XXXX00000X bill',
    'Client ID,XX0000',
    'TATATECH,INE142M01025,2025-09-12,NSE,EQ,EQ,sell,false,10.000000,700.599976,606003128,1300000051263385',
    'Net P&L,1234567890.50',
    '"JV1234567890","BP1234567890"',
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

  it('reports 1-based line numbers', () => {
    const findings = scanText('ok\nok\nPAN ABCDE1234F', 'f.csv', []);
    expect(findings[0]?.location).toBe('f.csv:3');
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
    const findings = scanWorkbook(workbook, 'r.xls', []);
    expect(findings).toEqual([{ kind: 'mobile', location: 'r.xls!Equity!B2', sample: '98***' }]);
  });
});
