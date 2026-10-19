// Helpers for reading values out of parsed spreadsheet cells and CSV fields, without float arithmetic.
import { normaliseDecimalString, parseDecimalToMicro, ParseError } from '@bhavbook/core';
import type { Cell } from './contract.js';

/**
 * A cell as a plain decimal string. Spreadsheet numbers are already IEEE doubles (SheetJS parsed them); we only
 * render them without exponent notation so they can be rounded back to the broker's precision as strings.
 */
export function cellText(cell: Cell | undefined): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'number')
    return cell.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  const trimmed = cell.trim();
  return trimmed === '' ? null : trimmed;
}

/** A money cell rounded half-up to `dp` places (the broker's published precision), in micro-rupees. */
export function moneyMicro(cell: Cell | undefined, dp: number): bigint | null {
  const text = cellText(cell);
  if (text === null) return null;
  try {
    return parseDecimalToMicro(normaliseDecimalString(text, dp, 'half-up'));
  } catch (error) {
    if (error instanceof ParseError) return null;
    throw error;
  }
}

export function isBlankRow(row: readonly Cell[] | undefined): boolean {
  return row === undefined || row.every((cell) => cellText(cell) === null);
}

/** `name → column index` for a header row. */
export function columnIndex(header: readonly Cell[]): Map<string, number> {
  const index = new Map<string, number>();
  header.forEach((cell, position) => {
    const name = cellText(cell);
    if (name !== null && !index.has(name)) index.set(name, position);
  });
  return index;
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
