// S6 review follow-ups: nothing may be silently dropped, and keys must survive re-exports.
import { describe, expect, it } from 'vitest';
import { dhanAdapter, type AdapterInput, type Cell } from '../../src/index.js';
import { readJournalCsv } from '../../src/dhan/journal-csv.js';

const TRADE_HEADER = 'Date,Time,Name,Buy/Sell,Order,Exchange,Segment,Quantity/Lot,Trade Price,Trade Value,Status';
const TRADE = '2024-09-18,09:16:45,Bajaj Housing Finance,SELL,DELIVERY,NSE,Equity,200,174.05,34810.00,Traded';

function trades(...lines: string[]): AdapterInput {
  return { type: 'text', text: [TRADE_HEADER, ...lines].join('\r\n') };
}

function journal(title: string, header: string, rows: string[]): string {
  return [`${title},From 01-04-2024 to 31-03-2025`, 'Name,X', '', header, ...rows, '', 'Total,1', '', 'NOTE : x'].join(
    '\r\n',
  );
}

const LOT_HEADER: Cell[] = [
  'Sr.',
  'Security Name',
  'ISIN',
  'Buy Date',
  'Buy Qty.',
  'Avg. Buy Price',
  'Buy Value',
  'Sell Date',
  'Sell Qty.',
  'Avg. Sell Price',
  'Sell Value',
  'Holding Period',
  'Gross P&L',
  'Total Charges',
  'Net P&L',
];
const LOT: Cell[] = [1, 'REC', 'INE020B01018', '04-06-2024', 20, 542.2, 10844, '04-06-2024', 20, 521.15, 10423, 0, -421, 11.1, -432.1];

function taxReport(rows: Cell[][]): AdapterInput {
  return {
    type: 'sheets',
    sheets: ['Equity', 'F&O', 'Global Transactions', 'DP Charges Statement'].map((name) => ({
      name,
      rows: name === 'Equity' ? rows : [],
    })),
  };
}

describe('dhan trade history: review follow-ups', () => {
  it('reports an unknown status instead of skipping it as not traded', () => {
    const result = dhanAdapter.parse(
      trades(TRADE.replace(',Traded', ',Part Traded'), TRADE.replace(',Traded', ',Cancelled')),
      'dhan.trade_history',
    );
    expect(result.errors).toEqual([{ line: 2, code: 'unknown_status' }]);
    expect(result.skipped).toEqual([{ line: 3, reason: 'not_traded' }]);
  });

  it('keys on normalised quantity and value, so 200 / 34810.00 and 200.0 / 34810.0 match', () => {
    const a = dhanAdapter.parse(trades(TRADE), 'dhan.trade_history').rows[0]?.dedupKey;
    const b = dhanAdapter.parse(trades(TRADE.replace(',200,', ',200.0,').replace(',34810.00,', ',34810.0,')), 'dhan.trade_history')
      .rows[0]?.dedupKey;
    expect(a).toBeDefined();
    expect(b).toBe(a);
  });
});

describe('dhan Journal CSVs: review follow-ups', () => {
  it('keeps reading data rows after a stray blank line and reports unexpected lines', () => {
    const text = ['T,From 01-04-2024 to 31-03-2025', '', 'A,B', '"1","2"', '', '"3","4"', 'odd', '', 'Total,1,Sum,2'].join(
      '\r\n',
    );
    const parsed = readJournalCsv(text, ['A', 'B']);
    expect(parsed.rows.map((row) => row.line)).toEqual([4, 6]);
    expect(parsed.unexpected).toEqual([7]);
    expect(parsed.summary).toEqual({ Total: '1', Sum: '2' });
  });

  it('reports Global Transactions rows with a non-numeric quantity', () => {
    const header =
      'Date,Scrip Name,Exchange,Bill No.,Buy Qty.,Buy Value,Sell Qty.,Sell Value,Brokerage,GST,STT,SEBI Fees,Stamp Duty,Txn. Charges,Oth. Charges,Gross Amount';
    const row = '"22 Apr 2024 00:00:00","REC","NSE","1","x","10.00","0","0.00","0","0","0","0","0","0","0","-10.00"';
    const result = dhanAdapter.parse({ type: 'text', text: journal('Global transction report', header, [row]) }, 'dhan.global_transactions');
    expect(result.errors).toEqual([{ line: 5, code: 'bad_row' }]);
  });

  it('keys DP rows on the name, so a missing ISIN does not create a second charge', () => {
    const header = 'Date,Scrip Name,ISIN,Quantity,Type of Transaction,Charges';
    const parse = (isin: string) =>
      dhanAdapter.parse(
        { type: 'text', text: journal('DP transction charges', header, [`"14 Jan 2025","REC","${isin}","3","DP Charges for Sale","12.50"`]) },
        'dhan.dp_charges',
      );
    expect(parse('NA').statements[0]?.dedupKey).toBe(parse('INE020B01018').statements[0]?.dedupKey);
    expect(parse('BAD').errors).toEqual([{ line: 5, code: 'bad_row' }]);
  });

  it('reports a name that maps to two ISINs', () => {
    const header = 'Date,Scrip Name,ISIN,Quantity,Type of Transaction,Charges';
    const rows = [
      '"14 Jan 2025","REC","INE020B01018","3","DP Charges for Sale","12.50"',
      '"15 Jan 2025","REC","INE002A01018","3","DP Charges for Sale","12.50"',
    ];
    const result = dhanAdapter.parse({ type: 'text', text: journal('DP transction charges', header, rows) }, 'dhan.dp_charges');
    expect(result.errors).toEqual([{ line: 6, code: 'isin_conflict' }]);
  });
});

describe('dhan Tax Report: review follow-ups', () => {
  it('reports a section title it does not know, and the lots under it', () => {
    const result = dhanAdapter.parse(
      taxReport([['Equity Segment - Short Term'], LOT_HEADER, LOT, ['Equity segment - long term'], LOT_HEADER, LOT]),
      'dhan.tax_report',
    );
    expect(result.statements).toHaveLength(1);
    expect(result.errors).toEqual([
      { line: 4, code: 'unknown_section' },
      { line: 6, code: 'bad_lot' },
    ]);
  });

  it('reports a truncated one-cell row inside a section and keeps reading', () => {
    const result = dhanAdapter.parse(taxReport([['Equity Segment - Short Term'], LOT_HEADER, ['REC'], LOT]), 'dhan.tax_report');
    expect(result.statements).toHaveLength(1);
    expect(result.errors).toEqual([{ line: 3, code: 'bad_lot' }]);
  });

  it('stops at the footer and records Free Holdings rows as skipped', () => {
    const result = dhanAdapter.parse(
      taxReport([
        ['Equity Segment - Free Holdings from 2024-04-01 to 2025-03-31'],
        ['Sr.', 'Security Name', 'ISIN', 'Buy Qty', 'Avg. Buy Price', 'Buy Value', 'Closing Rate', 'Unrealized P&L'],
        [1, 'REC', 'INE020B01018', 5, 500, 2500, 510, 50],
        ['This is a system generated report and thus does not require signature.'],
        ['1. Notes'],
      ]),
      'dhan.tax_report',
    );
    expect(result.skipped).toEqual([{ line: 3, reason: 'other' }]);
    expect(result.errors).toEqual([]);
  });

  it('reports a lot with an unreadable amount', () => {
    const bad = [...LOT];
    bad[13] = 'n/a';
    expect(dhanAdapter.parse(taxReport([['Equity Segment - Short Term'], LOT_HEADER, bad]), 'dhan.tax_report').errors).toEqual([
      { line: 3, code: 'bad_lot' },
    ]);
  });
});
