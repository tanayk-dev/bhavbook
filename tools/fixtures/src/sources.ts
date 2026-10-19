// Where each v1 report kind lives under docs/broker-exports (see docs/broker-exports/README.md).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLACEHOLDERS } from './placeholders.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export type SourceFormat = 'csv' | 'xlsx' | 'xls';

export interface FixtureSource {
  readonly broker: 'zerodha' | 'dhan';
  readonly kind: string;
  /** Directory relative to docs/broker-exports. */
  readonly dir: string;
  readonly format: SourceFormat;
  readonly replaceColumns?: Readonly<Record<string, string>>;
  /** Dhan Journal CSVs start with a Name/UCC/Mobile/Email block; finding none is an error. */
  readonly metadata?: boolean;
}

export const SOURCES: readonly FixtureSource[] = [
  { broker: 'zerodha', kind: 'tradebook', dir: 'zerodha/tradebook', format: 'csv' },
  { broker: 'zerodha', kind: 'tax_pnl', dir: 'zerodha/tax-pnl', format: 'xlsx' },
  { broker: 'zerodha', kind: 'agts', dir: 'zerodha/agts', format: 'xlsx' },
  { broker: 'zerodha', kind: 'pnl', dir: 'zerodha/pnl', format: 'xlsx' },
  { broker: 'dhan', kind: 'trade_history', dir: 'dhan/past-trades', format: 'csv' },
  { broker: 'dhan', kind: 'global_transactions', dir: 'dhan/global-tnx', format: 'csv', metadata: true },
  { broker: 'dhan', kind: 'dp_charges', dir: 'dhan/dp-charges', format: 'csv', metadata: true },
  { broker: 'dhan', kind: 'tax_report', dir: 'dhan/tax-report', format: 'xls' },
  { broker: 'dhan', kind: 'pnl', dir: 'dhan/pnl', format: 'csv', metadata: true },
  { broker: 'dhan', kind: 'realised_pnl', dir: 'dhan/pnl-realised', format: 'csv', metadata: true },
  { broker: 'dhan', kind: 'ledger', dir: 'dhan/ledger', format: 'csv', metadata: true },
  {
    broker: 'dhan',
    kind: 'fund_summary',
    dir: 'dhan/funds-summary',
    format: 'csv',
    metadata: true,
    replaceColumns: { Bank: PLACEHOLDERS.bank },
  },
];
