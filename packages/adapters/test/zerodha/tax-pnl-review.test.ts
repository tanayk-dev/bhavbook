// S5b review follow-ups for the tax P&L parser.
import { describe, expect, it } from 'vitest';
import { zerodhaAdapter, type AdapterInput, type Cell } from '../../src/index.js';
import { sheetInput } from '../helpers/fixtures.js';

const HEADER: Cell[] = [
  'Symbol',
  'ISIN',
  'Entry Date',
  'Exit Date',
  'Quantity',
  'Buy Value',
  'Sell Value',
  'Profit',
  'Period of Holding',
  'Fair Market Value',
  'Taxable Profit',
  'Turnover',
  'Brokerage',
  'Exchange Transaction Charges',
  'IPFT',
  'SEBI Charges',
  'CGST',
  'SGST',
  'IGST',
  'Stamp Duty',
  'STT',
];
const LOT: Cell[] = [
  'TCS',
  'INE467B01029',
  '2024-05-02',
  '2024-05-02',
  5,
  100.00005,
  110,
  10,
  0,
  0,
  10,
  10,
  0.12345,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
];

function book(tradewise: Cell[][], extra: { name: string; rows: Cell[][] }[] = []): AdapterInput {
  return {
    type: 'sheets',
    sheets: [
      { name: 'Tradewise Exits from 2024-04-01', rows: tradewise },
      { name: 'Equity and Non Equity', rows: [] },
      ...extra,
    ],
  };
}

function lots(input: AdapterInput): string[] {
  return zerodhaAdapter
    .parse(input, 'zerodha.tax_pnl')
    .statements.filter((row) => row.kind === 'zerodha.tax_pnl.lot')
    .map((row) => row.key.section ?? '');
}

describe('zerodha tax P&L: review follow-ups', () => {
  it('does not let an unknown section title inherit the previous section', () => {
    const input = book([['Equity - Intraday'], HEADER, LOT, [null], ['Equity - Something New'], HEADER, LOT]);
    expect(lots(input)).toEqual(['intraday']);
    expect(zerodhaAdapter.parse(input, 'zerodha.tax_pnl').errors).toEqual([
      { line: 5, code: 'unknown_section' },
    ]);
  });

  it('keeps reading after a blank row inside a table', () => {
    expect(lots(book([['Equity - Short Term'], HEADER, LOT, [null, null], LOT]))).toHaveLength(2);
  });

  it('rounds 5-decimal values half-up to 4 dp', () => {
    const [row] = zerodhaAdapter.parse(
      book([['Equity - Short Term'], HEADER, LOT]),
      'zerodha.tax_pnl',
    ).statements;
    expect(row?.data).toMatchObject({ buy_value_micro: 100_000_100n, brokerage_micro: 123_500n });
  });

  it('reports a lot whose required money field is not a number', () => {
    const bad = [...LOT];
    bad[5] = 'NA';
    expect(
      zerodhaAdapter.parse(book([['Equity - Short Term'], HEADER, bad]), 'zerodha.tax_pnl').errors,
    ).toEqual([{ line: 3, code: 'bad_lot' }]);
  });

  it('reports a section header missing required columns', () => {
    const result = zerodhaAdapter.parse(
      book([['Equity - Short Term'], HEADER.slice(0, 5), LOT]),
      'zerodha.tax_pnl',
    );
    expect(result.errors[0]).toEqual({ line: 2, code: 'bad_header' });
  });

  it('reports DP rows it cannot read instead of dropping them', () => {
    const other = {
      name: 'Other Debits and Credits',
      rows: [
        ['Particulars', 'Posting Date', 'Debit', 'Credit'],
        ['DP Charges for Sale of TCS on 32/13/2024', '2024-12-13', 15.34, 0],
        ['DP Charges for Sale of TCS on 13/12/2024', '2024-12-13', null, 0],
      ],
    };
    expect(zerodhaAdapter.parse(book([], [other]), 'zerodha.tax_pnl').errors).toEqual([
      { line: 2, code: 'bad_dp_row' },
      { line: 3, code: 'bad_dp_row' },
    ]);
  });

  it('records only non-equity reasons for skipped rows on the real file', () => {
    const real = zerodhaAdapter.parse(sheetInput('zerodha', 'tax_pnl'), 'zerodha.tax_pnl');
    for (const entry of real.skipped) expect(['mf', 'fno', 'currency', 'commodity']).toContain(entry.reason);
  });

  it('never outputs the values next to Client ID, Client Name or PAN', () => {
    const real = sheetInput('zerodha', 'tax_pnl');
    const labels = new Set(['Client ID', 'Client Name', 'PAN']);
    const secrets = real.sheets.flatMap((sheet) =>
      sheet.rows.flatMap((row) =>
        row.flatMap((cell, index) => (typeof cell === 'string' && labels.has(cell) ? [row[index + 1]] : [])),
      ),
    );
    expect(secrets.length).toBeGreaterThan(0);
    const text = JSON.stringify(zerodhaAdapter.parse(real, 'zerodha.tax_pnl'), (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    for (const secret of secrets)
      if (typeof secret === 'string' && secret.length > 2) expect(text).not.toContain(secret);
  });
});
