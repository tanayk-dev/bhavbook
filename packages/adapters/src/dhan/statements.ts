// Dhan Journal CSVs imported as statements (NOTES.md): Global Transactions (per date x scrip charge breakdown, the
// contract-note reconciliation source) and DP Charges (per sale, plus the scrip name -> ISIN join). Two decimals.
import type { InstrumentHint, ParseResult, RowError, StatementRow } from '../contract.js';
import { moneyMicro } from '../cells.js';
import { fromDayMonthName } from './dates.js';
import { readJournalCsv } from './journal-csv.js';

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

const GT_MONEY: readonly (readonly [string, string])[] = [
  ['Buy Value', 'buy_value_micro'],
  ['Sell Value', 'sell_value_micro'],
  ['Brokerage', 'brokerage_micro'],
  ['GST', 'gst_micro'],
  ['STT', 'stt_micro'],
  ['SEBI Fees', 'sebi_micro'],
  ['Stamp Duty', 'stamp_duty_micro'],
  ['Txn. Charges', 'txn_micro'],
  ['Oth. Charges', 'other_micro'],
  ['Gross Amount', 'gross_amount_micro'],
];
const GT_HEADER = [
  'Date',
  'Scrip Name',
  'Exchange',
  'Bill No.',
  'Buy Qty.',
  'Sell Qty.',
  ...GT_MONEY.map(([name]) => name),
];
const DP_HEADER = ['Date', 'Scrip Name', 'ISIN', 'Quantity', 'Type of Transaction', 'Charges'];

/** Appends `#n` so repeated identical keys stay distinct and stable across re-imports. */
function occurrenceKeys(): (key: string) => string {
  const seen = new Map<string, number>();
  return (key) => {
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return `${key}#${String(count)}`;
  };
}

function result(statements: StatementRow[], errors: RowError[], extra: Partial<ParseResult>): ParseResult {
  return { rows: [], statements, instrumentHints: [], skipped: [], errors, coverage: null, ...extra };
}

export function parseGlobalTransactions(text: string): ParseResult {
  const csv = readJournalCsv(text, GT_HEADER);
  const keyOf = occurrenceKeys();
  const statements: StatementRow[] = [];
  const errors: RowError[] = [];
  for (const { line, fields } of csv.rows) {
    const date = fromDayMonthName(fields.Date ?? '');
    const name = fields['Scrip Name'] ?? '';
    const data: Record<string, bigint | string | null> = {
      buy_qty: fields['Buy Qty.'] ?? '',
      sell_qty: fields['Sell Qty.'] ?? '',
    };
    for (const [column, field] of GT_MONEY) data[field] = moneyMicro(fields[column] ?? null, 2);
    if (date === null || name === '' || Object.values(data).some((value) => value === null)) {
      errors.push({ line, code: 'bad_row' });
      continue;
    }
    const key = { date, name, exchange: fields.Exchange ?? '', bill_no: fields['Bill No.'] ?? '' };
    const identity = ['gt', date, key.exchange, key.bill_no, name].join('|');
    statements.push({ kind: 'dhan.gt.row', dedupKey: keyOf(identity), key, data, line });
  }
  return result(statements, errors, { coverage: csv.coverage });
}

export function parseDpCharges(text: string): ParseResult {
  const csv = readJournalCsv(text, DP_HEADER);
  const keyOf = occurrenceKeys();
  const statements: StatementRow[] = [];
  const hints: InstrumentHint[] = [];
  const errors: RowError[] = [];
  for (const { line, fields } of csv.rows) {
    const date = fromDayMonthName(fields.Date ?? '');
    const name = fields['Scrip Name'] ?? '';
    const type = fields['Type of Transaction'] ?? '';
    const isin = ISIN.test(fields.ISIN ?? '') ? (fields.ISIN ?? '') : '';
    const charges = moneyMicro(fields.Charges ?? null, 2);
    if (date === null || name === '' || type === '' || charges === null) {
      errors.push({ line, code: 'bad_row' });
      continue;
    }
    const key = { date, name, isin, type };
    const identity = ['dp', date, type, isin || name].join('|');
    statements.push({
      kind: 'dhan.dp.row',
      dedupKey: keyOf(identity),
      key,
      data: { quantity: fields.Quantity ?? '', charges_micro: charges },
      line,
    });
    if (isin !== '' && !hints.some((hint) => hint.name === name)) hints.push({ name, isin, line });
  }
  return result(statements, errors, { instrumentHints: hints, coverage: csv.coverage });
}
