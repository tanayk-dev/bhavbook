import { describe, expect, it } from 'vitest';
import { detectReport, dhanAdapter, parseResultSchema } from '../../src/index.js';
import { probeOf, sheetInput, textInput } from '../helpers/fixtures.js';

function noMetadata(value: unknown): void {
  const text = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
  for (const placeholder of ['TEST USER', 'XXXX00000X', '1234567890', 'test@example.com', 'testxxx']) {
    expect(text).not.toContain(placeholder);
  }
}

describe('dhan Global Transactions', () => {
  const input = textInput('dhan', 'global_transactions');
  const result = dhanAdapter.parse(input, 'dhan.global_transactions');

  it('is detected from its title line', () => {
    expect(dhanAdapter.detect(probeOf(input))).toEqual({ kind: 'dhan.global_transactions', confidence: 1 });
  });

  it('reads one charge row per (date, scrip) with the full breakdown in micro-rupees', () => {
    expect(() => parseResultSchema.parse(result)).not.toThrow();
    expect(result.statements).toHaveLength(80);
    expect(result.statements[0]).toMatchObject({
      kind: 'dhan.gt.row',
      key: { date: '2024-04-22', name: 'Electrosteel Castings', exchange: 'NSE', bill_no: '374286' },
      data: {
        buy_qty: '75',
        buy_value_micro: 15_257_500_000n,
        stt_micro: 15_390_000n,
        stamp_duty_micro: 2_660_000n,
        txn_micro: 490_000n,
        gst_micro: 90_000n,
        gross_amount_micro: -15_276_160_000n,
      },
    });
    expect(result.coverage).toEqual({ from: '2024-04-01', to: '2025-03-31' });
  });

  it('never outputs the metadata block (name, UCC, mobile, email)', () => {
    noMetadata(result);
  });
});

describe('dhan DP charges', () => {
  const result = dhanAdapter.parse(textInput('dhan', 'dp_charges'), 'dhan.dp_charges');

  it('reads DP rows and learns name -> ISIN hints, skipping the GST summary rows', () => {
    expect(() => parseResultSchema.parse(result)).not.toThrow();
    expect(result.statements.find((row) => row.key.name === 'KPIT Technologies')).toMatchObject({
      kind: 'dhan.dp.row',
      key: { date: '2025-01-14', isin: 'INE04I401011', type: 'DP Charges for Sale' },
      data: { quantity: '3', charges_micro: 12_500_000n },
    });
    expect(result.instrumentHints).toContainEqual(
      expect.objectContaining({ name: 'KPIT Technologies', isin: 'INE04I401011' }),
    );
    expect(result.instrumentHints.every((hint) => hint.isin !== 'NA')).toBe(true);
    noMetadata(result);
  });
});

describe('dhan Tax Report (.xls)', () => {
  const input = sheetInput('dhan', 'tax_report');
  const result = dhanAdapter.parse(input, 'dhan.tax_report');
  const lots = result.statements.filter((row) => row.kind === 'dhan.tax.lot');

  it('is detected from its sheets', () => {
    expect(dhanAdapter.detect(probeOf(input))).toEqual({ kind: 'dhan.tax_report', confidence: 1 });
  });

  it('reads every FIFO lot by section: 11 intraday, 35 short term, none long term', () => {
    expect(() => parseResultSchema.parse(result)).not.toThrow();
    const count = (section: string): number => lots.filter((row) => row.key.section === section).length;
    expect(count('intraday')).toBe(11);
    expect(count('short_term')).toBe(35);
    expect(count('long_term')).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.coverage).toEqual({ from: '2024-04-01', to: '2025-03-31' });
  });

  it('includes the IPO lot that the trade file lacks (Bajaj Housing, 200 @ 176, bought 17-09-2024)', () => {
    expect(lots).toContainEqual(
      expect.objectContaining({
        key: expect.objectContaining({
          name: 'Bajaj Housing Finance',
          buy_date: '2024-09-17',
          quantity: '200',
        }) as unknown,
        data: expect.objectContaining({
          buy_value_micro: 35_200_000_000n,
          sell_value_micro: 34_810_000_000n,
        }) as unknown,
      }),
    );
  });

  it('rounds float-noise cells to paise and learns statement name -> ISIN', () => {
    expect(lots[0]?.data).toMatchObject({ gross_pnl_micro: -750_000_000n, total_charges_micro: 19_380_000n });
    expect(result.instrumentHints).toContainEqual(
      expect.objectContaining({ name: 'REC', isin: 'INE020B01018' }),
    );
  });

  it('never outputs the header block', () => {
    noMetadata(result);
    expect(JSON.stringify(result, (_k, v: unknown) => (typeof v === 'bigint' ? '' : v))).not.toContain(
      'XXXXX XXXXX',
    );
  });
});

describe('dhan rejected kinds', () => {
  it.each([
    ['pnl', 'dhan.pnl'],
    ['realised_pnl', 'dhan.realised_pnl'],
    ['ledger', 'dhan.ledger'],
    ['fund_summary', 'dhan.fund_summary'],
  ])('recognises %s and turns it away with a message', (fixture, kind) => {
    const [candidate] = detectReport([dhanAdapter], probeOf(textInput('dhan', fixture)));
    expect(candidate?.kind).toBe(kind);
    expect(candidate?.rejected).toMatch(/v1/);
  });
});
