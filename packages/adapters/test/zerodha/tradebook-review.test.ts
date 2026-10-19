// S5b review follow-ups for the tradebook parser.
import { describe, expect, it } from 'vitest';
import { zerodhaAdapter, type AdapterInput } from '../../src/index.js';

const HEADER =
  'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';
const GOOD =
  'TCS,INE467B01029,2025-09-12,NSE,EQ,EQ,sell,false,5.000000,3130.600098,606003125,1300000051263375,2025-09-12T14:50:01';

function csv(...lines: string[]): AdapterInput {
  return { type: 'text', text: [HEADER, ...lines].join('\r\n') + '\r\n' };
}

describe('zerodha tradebook: review follow-ups', () => {
  it('turns csv-parse failures into a fixed message that never quotes the file', () => {
    const text = `${HEADER}\r\nTCS,"INE467B01029,2025-09-12\r\nSECRET"x,y`;
    try {
      zerodhaAdapter.parse({ type: 'text', text }, 'zerodha.tradebook');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe('malformed CSV');
      expect(String((error as Error).stack)).not.toContain('SECRET');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it.each([
    ['a prototype key as side', GOOD.replace(',sell,', ',constructor,'), 'bad_side'],
    ['a zero price', GOOD.replace('3130.600098', '0'), 'non_positive_price'],
    ['a negative price', GOOD.replace('3130.600098', '-5'), 'non_positive_price'],
    ['an impossible date', GOOD.replace('2025-09-12,NSE', '2025-02-30,NSE'), 'bad_date'],
    [
      'a trade date that disagrees with the execution time',
      GOOD.replace('2025-09-12,NSE', '2025-09-13,NSE'),
      'date_mismatch',
    ],
    ['a missing execution time', GOOD.replace('2025-09-12T14:50:01', ''), 'bad_time'],
  ])('reports %s', (_label, line, code) => {
    expect(zerodhaAdapter.parse(csv(line), 'zerodha.tradebook').errors).toEqual([{ line: 2, code }]);
  });

  it('reports a repeated fill once as a duplicate', () => {
    const result = zerodhaAdapter.parse(csv(GOOD, GOOD), 'zerodha.tradebook');
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toEqual([{ line: 3, code: 'duplicate_row' }]);
  });

  it('accepts case, quoting and extra columns in the header (e.g. an F&O export) and skips F&O rows', () => {
    const header =
      '"Symbol","ISIN","Trade_Date",Exchange,Segment,Series,Trade_Type,Auction,Quantity,Price,Trade_ID,Order_ID,Order_Execution_Time,Expiry_Date';
    const fno = 'NIFTY25SEPFUT,,2025-09-12,NFO,FO,,buy,false,75,24500,1,2,2025-09-12T10:00:00,2025-09-25';
    const text = `${header}\r\n${fno}\r\n${GOOD},\r\n`;
    expect(zerodhaAdapter.detect({ type: 'text', head: text })).toEqual({
      kind: 'zerodha.tradebook',
      confidence: 0.9,
    });
    const result = zerodhaAdapter.parse({ type: 'text', text }, 'zerodha.tradebook');
    expect(result.skipped).toEqual([{ line: 2, reason: 'fno' }]);
    expect(result.rows).toHaveLength(1);
  });

  it('ignores blank and whitespace-only lines, keeping line numbers right', () => {
    const text = `${HEADER}\r\n\r\n   \r\n${GOOD.replace(',sell,', ',hold,')}\r\n`;
    expect(zerodhaAdapter.parse({ type: 'text', text }, 'zerodha.tradebook').errors).toEqual([
      { line: 4, code: 'bad_side' },
    ]);
  });

  it('handles a UTF-8 BOM and lowercase values', () => {
    const line = GOOD.replace(',NSE,', ',nse,').replace(',sell,', ',SELL,');
    const result = zerodhaAdapter.parse({ type: 'text', text: `﻿${HEADER}\r\n${line}` }, 'zerodha.tradebook');
    expect(result.rows[0]).toMatchObject({ exchange: 'NSE', side: 'SELL' });
  });
});
