// Test-only reader for Dhan's Journal P&L report (plan S6 task 5). Not part of the product: `dhan.pnl` is a rejected
// kind in v1, but its realised totals are the golden check for analytics (plan S15a, PRD §1 success signal).
import { parseDecimalToMicro } from '@bhavbook/core';

export interface DhanPnl {
  /** `Gross P&L` from the summary line; checked against the rows' sum. */
  readonly grossMicro: bigint;
  /** Per scrip: `Realised P&L`. */
  readonly realised: ReadonlyMap<string, bigint>;
}

/** Splits one CSV line; Dhan quotes every row field and leaves the summary line bare. */
function fields(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      out.push(current);
      current = '';
    } else current += char;
  }
  out.push(current);
  return out;
}

export function readDhanPnl(text: string): DhanPnl {
  const lines = text.split(/\r?\n/);
  const headerAt = lines.findIndex((line) => line.startsWith('Scrip Name,'));
  if (headerAt < 0) throw new Error('not a Dhan P&L report');
  const header = fields(lines[headerAt] ?? '');
  const at = (name: string): number => header.indexOf(name);
  const realised = new Map<string, bigint>();
  for (const line of lines.slice(headerAt + 1)) {
    const row = fields(line);
    if (row.length !== header.length) continue;
    const name = row[at('Scrip Name')] ?? '';
    realised.set(name, (realised.get(name) ?? 0n) + parseDecimalToMicro(row[at('Realised P&L')] ?? ''));
  }
  const summary = fields(lines.find((line) => line.startsWith('Net P&L,')) ?? '');
  const value = (label: string): bigint => {
    const index = summary.indexOf(label);
    if (index < 0) throw new Error(`the P&L summary has no ${label}`);
    return parseDecimalToMicro(summary[index + 1] ?? '');
  };
  const grossMicro = value('Gross P&L');
  const rows = [...realised.values()].reduce((sum, amount) => sum + amount, 0n);
  // A row the parser skipped would otherwise vanish from every comparison.
  if (rows !== grossMicro) throw new Error('the P&L rows do not add up to its Gross P&L');
  return { grossMicro, realised };
}
