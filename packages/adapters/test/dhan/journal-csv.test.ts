import { describe, expect, it } from 'vitest';
import { readJournalCsv } from '../../src/dhan/journal-csv.js';

const FILE = [
  'PnL report,From 01-04-2024 to 31-03-2025',
  'Name,REAL PERSON',
  'UCC,1100000001',
  'Mobile,9876543210',
  'Email ID,real.person@gmail.com',
  '',
  'Scrip Name,Buy Qty.',
  '"Tejas Networks","10"',
  '"Gabriel, Inc","165"',
  '',
  'Net P&L,-7219.12,Brokerage,148.51',
  '',
  'NOTE : This sheet was downloaded at 10/18/2026 10:08 PM',
].join('\r\n');

describe('readJournalCsv', () => {
  const parsed = readJournalCsv(FILE, ['Scrip Name', 'Buy Qty.']);

  it('returns the data rows with their file line numbers and raw text', () => {
    expect(parsed.rows).toEqual([
      { line: 8, fields: { 'Scrip Name': 'Tejas Networks', 'Buy Qty.': '10' }, raw: '"Tejas Networks","10"' },
      { line: 9, fields: { 'Scrip Name': 'Gabriel, Inc', 'Buy Qty.': '165' }, raw: '"Gabriel, Inc","165"' },
    ]);
  });

  it('parses the summary line into pairs and the period from the title', () => {
    expect(parsed.summary).toEqual({ 'Net P&L': '-7219.12', Brokerage: '148.51' });
    expect(parsed.coverage).toEqual({ from: '2024-04-01', to: '2025-03-31' });
  });

  it('never exposes the metadata block', () => {
    expect(JSON.stringify(parsed)).not.toMatch(/REAL PERSON|1100000001|9876543210|gmail/);
  });

  it('refuses a file without the expected header', () => {
    expect(() => readJournalCsv(FILE, ['Date', 'Scrip Name'])).toThrow(/header/);
  });
});
