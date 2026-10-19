// Name -> ISIN hints learnt from statements. One name must map to one ISIN; a second, different ISIN is reported
// rather than silently ignored.
import type { InstrumentHint, RowError } from './contract.js';

export const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

export function addHint(hints: InstrumentHint[], errors: RowError[], hint: InstrumentHint): void {
  const known = hints.find((entry) => entry.name === hint.name);
  if (known === undefined) hints.push(hint);
  else if (known.isin !== hint.isin) errors.push({ line: hint.line, code: 'isin_conflict' });
}
