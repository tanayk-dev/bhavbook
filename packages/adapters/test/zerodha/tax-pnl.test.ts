import { describe, expect, it } from 'vitest';
import { detectReport, parseResultSchema, zerodhaAdapter } from '../../src/index.js';
import { probeOf, sheetInput } from '../helpers/fixtures.js';

describe('zerodha tax P&L', () => {
  const input = sheetInput('zerodha', 'tax_pnl');
  const result = zerodhaAdapter.parse(input, 'zerodha.tax_pnl');
  const lots = result.statements.filter((row) => row.kind === 'zerodha.tax_pnl.lot');
  const dp = result.statements.filter((row) => row.kind === 'zerodha.tax_pnl.dp');

  it('is detected from its sheet names', () => {
    expect(zerodhaAdapter.detect(probeOf(input))).toEqual({ kind: 'zerodha.tax_pnl', confidence: 1 });
  });

  it('produces a schema-valid result with lots and no trade rows', () => {
    expect(() => parseResultSchema.parse(result)).not.toThrow();
    expect(result.rows).toEqual([]);
    expect(lots.length).toBeGreaterThan(40);
    expect(result.coverage).toEqual({ from: '2024-04-01', to: '2025-03-31' });
  });

  it('reads per-lot charges to 4 decimals, including negative stamp-duty allocations', () => {
    const [first] = lots;
    expect(first?.key).toMatchObject({ section: 'intraday', symbol: 'BAJEL', isin: 'INE0KQN01018' });
    expect(first?.key).toMatchObject({ entry_date: '2024-04-19', exit_date: '2024-04-19', quantity: '25' });
    expect(first?.data).toMatchObject({
      buy_value_micro: 6_110_000_000n,
      sell_value_micro: 6_275_000_000n,
      brokerage_micro: 3_715_500n,
      exchange_txn_micro: 398_800n,
      ipft_micro: 12_400n,
      sebi_micro: 12_400n,
      igst_micro: 745_000n,
      stamp_duty_micro: -5_500n,
      stt_micro: 1_606_500n,
    });
  });

  it('labels every equity section and keeps identical lots apart (occurrence index)', () => {
    // The Buyback section exists in this file but has no rows.
    expect(new Set(lots.map((row) => row.key.section))).toEqual(
      new Set(['intraday', 'short_term', 'long_term']),
    );
    const dvr = lots.filter((row) => row.key.symbol === 'TATAMTRDVR');
    expect(dvr.length).toBeGreaterThanOrEqual(2);
    expect(new Set(lots.map((row) => row.dedupKey)).size).toBe(lots.length);
  });

  it('reads DP charges per scrip and sale date from "Other Debits and Credits"', () => {
    const expected = input.sheets
      .find((sheet) => sheet.name === 'Other Debits and Credits')
      ?.rows.filter((row) =>
        row.some((cell) => typeof cell === 'string' && cell.startsWith('DP Charges for Sale of')),
      ).length;
    expect(dp).toHaveLength(expected ?? -1);
    expect(dp.find((row) => row.key.symbol === 'INDHOTEL')).toMatchObject({
      key: { symbol: 'INDHOTEL', sale_date: '2024-12-13' },
      data: { amount_micro: 15_340_000n },
    });
  });

  it('never outputs the header block (client ID, name, PAN)', () => {
    const text = JSON.stringify(result, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(text).not.toMatch(/Client ID|Client Name|XXXXX0000X|XXX000/);
  });

  it('skips mutual fund, F&O, currency and commodity sections without failing', () => {
    expect(result.errors).toEqual([]);
  });
});

describe('zerodha rejected kinds', () => {
  it.each([
    ['agts', 'zerodha.agts'],
    ['pnl', 'zerodha.pnl'],
  ])('recognises %s and turns it away with a message', (fixture, kind) => {
    const [candidate] = detectReport([zerodhaAdapter], probeOf(sheetInput('zerodha', fixture)));
    expect(candidate?.kind).toBe(kind);
    expect(candidate?.rejected).toMatch(/not needed|v1/);
  });
});
