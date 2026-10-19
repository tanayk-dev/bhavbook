// Dhan Journal CSVs imported as statements (NOTES.md): Global Transactions (per date x scrip charge breakdown, the
// contract-note reconciliation source) and DP Charges (per sale, plus the scrip name -> ISIN join). Two decimals.
import type { InstrumentHint, ParseResult, RowError, StatementRow } from '../contract.js';
import { moneyMicro } from '../cells.js';
import { fromDayMonthName } from './dates.js';
import { addHint, ISIN_PATTERN } from '../hints.js';
import { readJournalCsv, type JournalCsv } from './journal-csv.js';

const QUANTITY = /^\d+$/;

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

/** Unexpected lines in the file are row errors too; errors are reported in file order. */
function result(
  csv: JournalCsv,
  statements: StatementRow[],
  errors: RowError[],
  instrumentHints: ParseResult['instrumentHints'] = [],
): ParseResult {
  const all = [...errors, ...csv.unexpected.map((line) => ({ line, code: 'bad_row' }))].sort(
    (a, b) => a.line - b.line,
  );
  return { rows: [], statements, instrumentHints, skipped: [], errors: all, coverage: csv.coverage };
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
    const quantities = [data.buy_qty, data.sell_qty];
    const badQuantity = quantities.some((value) => typeof value !== 'string' || !QUANTITY.test(value));
    if (date === null || name === '' || badQuantity || Object.values(data).some((value) => value === null)) {
      errors.push({ line, code: 'bad_row' });
      continue;
    }
    const key = { date, name, exchange: fields.Exchange ?? '', bill_no: fields['Bill No.'] ?? '' };
    const identity = ['gt', date, key.exchange, key.bill_no, name].join('|');
    statements.push({ kind: 'dhan.gt.row', dedupKey: keyOf(identity), key, data, line });
  }
  return result(csv, statements, errors);
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
    // Dhan writes `NA` on the GST summary rows; anything else must be a real ISIN.
    const rawIsin = fields.ISIN ?? '';
    const isin = rawIsin === 'NA' ? '' : rawIsin;
    const quantity = fields.Quantity ?? '';
    const charges = moneyMicro(fields.Charges ?? null, 2);
    const badIsin = isin !== '' && !ISIN_PATTERN.test(isin);
    if (
      date === null ||
      name === '' ||
      type === '' ||
      badIsin ||
      !QUANTITY.test(quantity) ||
      charges === null
    ) {
      errors.push({ line, code: 'bad_row' });
      continue;
    }
    const key = { date, name, isin, type };
    // The name, not the ISIN: whether an export carries the ISIN must not change the key.
    const identity = ['dp', date, type, name, quantity, String(charges)].join('|');
    statements.push({
      kind: 'dhan.dp.row',
      dedupKey: keyOf(identity),
      key,
      data: { quantity, charges_micro: charges },
      line,
    });
    if (isin !== '') addHint(hints, errors, { name, isin, line });
  }
  return result(csv, statements, errors, hints);
}
