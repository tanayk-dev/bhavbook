// Dhan adapter: trade history, Global Transactions, DP Charges and the Tax Report; P&L, Realised P&L, Ledger and
// Fund Summary are recognised but not imported in v1 (PRD §6.3).
import type {
  AdapterInput,
  BrokerAdapter,
  Detection,
  FileProbe,
  ParseResult,
  ReportKind,
} from '../contract.js';
import { journalTitle } from './journal-csv.js';
import { parseDpCharges, parseGlobalTransactions } from './statements.js';
import { isTaxReport, parseTaxReport } from './tax-report.js';
import { isTradeHistoryHeader, parseTradeHistory } from './trade-history.js';

/** First-line titles of the Journal CSVs (lower-cased; Dhan spells "transction"). */
const TITLES: ReadonlyMap<string, ReportKind> = new Map([
  ['global transction report', 'dhan.global_transactions'],
  ['global transaction report', 'dhan.global_transactions'],
  ['dp transction charges', 'dhan.dp_charges'],
  ['dp transaction charges', 'dhan.dp_charges'],
  ['pnl report', 'dhan.pnl'],
  ['realised pnl report', 'dhan.realised_pnl'],
  ['ledger statement', 'dhan.ledger'],
  ['fund summary', 'dhan.fund_summary'],
]);

function detect(probe: FileProbe): Detection | null {
  if (probe.type === 'sheets') {
    return isTaxReport(probe.sheets.map((sheet) => sheet.name))
      ? { kind: 'dhan.tax_report', confidence: 1 }
      : null;
  }
  if (isTradeHistoryHeader(probe.head.split(/\r?\n/, 1)[0] ?? ''))
    return { kind: 'dhan.trade_history', confidence: 1 };
  const kind = TITLES.get(journalTitle(probe.head).toLowerCase());
  return kind === undefined ? null : { kind, confidence: 1 };
}

function parse(input: AdapterInput, kind: ReportKind): ParseResult {
  if (input.type === 'sheets') {
    if (kind === 'dhan.tax_report') return parseTaxReport(input.sheets);
  } else if (kind === 'dhan.trade_history') {
    return parseTradeHistory(input.text);
  } else if (kind === 'dhan.global_transactions') {
    return parseGlobalTransactions(input.text);
  } else if (kind === 'dhan.dp_charges') {
    return parseDpCharges(input.text);
  }
  throw new Error(`dhan adapter cannot parse ${kind} from ${input.type} input`);
}

export const dhanAdapter: BrokerAdapter = {
  broker: 'dhan',
  version: '1',
  reportKinds: ['dhan.trade_history', 'dhan.global_transactions', 'dhan.dp_charges', 'dhan.tax_report'],
  rejectedKinds: [
    {
      kind: 'dhan.pnl',
      message:
        'The P&L report is not needed in v1. Import the Trade History and Global Transactions instead.',
    },
    {
      kind: 'dhan.realised_pnl',
      message:
        'The Realised P&L report is not needed in v1. Import the Trade History and the Tax Report instead.',
    },
    { kind: 'dhan.ledger', message: 'The Ledger is not imported in v1. Import the Trade History instead.' },
    { kind: 'dhan.fund_summary', message: 'Fund transfers are not imported in v1.' },
  ],
  detect,
  parse,
};
