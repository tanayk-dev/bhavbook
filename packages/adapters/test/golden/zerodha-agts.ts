// Test-only reader for Zerodha's Annual Global Transaction Statement (AGTS). Not part of the product: AGTS is a
// rejected kind in v1, but its per-(symbol, exchange) totals are a golden check for the tradebook parser.
import { normaliseDecimalString, parseDecimalToMicro } from '@bhavbook/core';
import type { SheetData } from '../../src/index.js';

export interface AgtsTotals {
  readonly buyQuantity: bigint;
  readonly buyValueMicro: bigint;
  readonly sellQuantity: bigint;
  readonly sellValueMicro: bigint;
}

function money(cell: unknown): bigint {
  const text =
    typeof cell === 'number'
      ? cell.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
      : String(cell);
  return parseDecimalToMicro(normaliseDecimalString(text, 2, 'half-up'));
}

/** `SYMBOL|EXCHANGE` → totals, from the AGTS Equity sheet. */
export function readAgtsEquity(sheets: readonly SheetData[]): Map<string, AgtsTotals> {
  const sheet = sheets.find((candidate) => candidate.name === 'Equity');
  if (!sheet) throw new Error('AGTS has no Equity sheet');
  const totals = new Map<string, AgtsTotals>();
  const headerIndex = sheet.rows.findIndex((row) => row.includes('Symbol') && row.includes('Buy Value'));
  const header = sheet.rows[headerIndex] ?? [];
  const at = (name: string): number => header.indexOf(name);
  for (const row of sheet.rows.slice(headerIndex + 1)) {
    const symbol = row[at('Symbol')];
    if (typeof symbol !== 'string' || symbol === '') break;
    totals.set(`${symbol}|${String(row[at('Exchange')])}`, {
      buyQuantity: BigInt(String(row[at('Buy Quantity')])),
      buyValueMicro: money(row[at('Buy Value')]),
      sellQuantity: BigInt(String(row[at('Sell Quantity')])),
      sellValueMicro: money(row[at('Sell Value')]),
    });
  }
  return totals;
}
