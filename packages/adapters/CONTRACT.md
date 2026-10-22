# Writing a broker adapter

An adapter turns one broker's export files into BhavBook's **canonical rows**. Read ADR-0008 (contract), ADR-0009 (dedup keys) and ADR-0010 (price normalisation) first. The types and runtime schemas live in [`src/contract.ts`](src/contract.ts).

## The rules

1. **Pure.** `detect` and `parse` take data and return data. No file, network, database or worker access. The lint rules enforce this inside `packages/adapters`. The server reads the file and, for XLSX/XLS, parses it in an isolated worker before your code sees it.
2. **No floats for money.** Convert decimal strings with `parseDecimalToMicro` and `normaliseDecimalString` from `@bhavbook/core`. Every `…Micro` value is a `bigint`. Spreadsheet cells arrive as JS numbers: convert them with `normaliseDecimalString(String(value), 2, 'half-up')` and never do arithmetic on them first.
3. **IST in, UTC out.** Broker timestamps have no timezone and are IST. Use `parseIstLocal` / `istDateOf` from `@bhavbook/core`.
4. **No personal data in the output.** Skip metadata blocks (name, client ID, PAN, mobile, email) entirely. A `RowError` carries a line number and a `snake_case` code only, never a cell value. The schemas reject anything else.
5. **Idempotent.** `dedupKey` must be stable across re-downloads of the same trades and unique within one account. Document how yours is built.
6. **Keep the raw row.** `raw.text` is the original line (or a faithful rendering of the sheet row) and `raw.line` its 1-based position.

## The interface

```ts
interface BrokerAdapter {
  broker: BrokerId; // 'zerodha' | 'dhan' (extend the enum for a new broker)
  version: string; // bump whenever the output for the same file changes
  reportKinds: ReportKind[]; // kinds this adapter imports, e.g. 'zerodha.tradebook'
  rejectedKinds: RejectedKind[]; // kinds it recognises but v1 doesn't import, with a user-facing message
  detect(probe: FileProbe): Detection | null; // cheap: header line or sheet names + first rows
  parse(input: AdapterInput, kind: ReportKind): ParseResult;
}
```

- **`detect`** returns `{ kind, confidence }`, where confidence is in `(0, 1]` and `1` means an exact header match. It returns `null` when the file isn't yours. `detectReport()` asks every adapter, so be specific.
- **`parse`** returns:
  - `rows`: trades;
  - `statements`: charge or lot rows used for reconciliation;
  - `instrumentHints`: statement name → ISIN pairs;
  - `skipped`: rows deliberately ignored (F&O, mutual funds, not executed) with a reason;
  - `errors`: rows that couldn't be read;
  - `coverage`: the date range the file covers.

## Fixtures and tests (required)

- Put anonymised, real-format files under `fixtures/<broker>/<kind>/`. Generate them with `pnpm fixtures:make` from exports kept in the gitignored `docs/broker-exports/`. Never hand-edit fixtures, and never commit real exports.
- Write tests first:
  - **detection**, including a near-miss file from another broker;
  - **golden output** on the fixtures, with exact row counts, money values and dedup keys;
  - **every quirk** in the broker's `NOTES.md`.
- Validate your output with `parseResultSchema.parse(result)` in the tests.
- `pnpm verify` must pass, including `pnpm pii:scan`.

## Adding a broker, step by step

1. **Collect real exports** from an account you own and put them under `docs/broker-exports/<broker>/` (gitignored).
   Write `docs/broker-exports/<broker>/NOTES.md`: where each report is downloaded, its layout, and every quirk you
   find. The Zerodha and Dhan notes are the model. Only the notes are committed.
2. **Make the fixtures:** add the broker's files to `tools/fixtures/src/sources.ts`, run `pnpm fixtures:make`, then `pnpm pii:scan`.
3. **Register the broker id:** `brokerIdSchema` in `src/contract.ts`, `SUPPORTED_BROKERS` in
   `packages/server/src/services/profiles.ts`, the analytics filter (`packages/server/src/services/analytics.ts` and
   `packages/web/src/lib/analytics.ts`), and `BROKERS` in `packages/web/src/lib/profiles.ts`.
4. **Write the failing tests**, then the adapter in `src/<broker>/` (the template below), and export it from
   `src/index.ts`.
5. **Plug it in:** add it to `DEFAULT_ADAPTERS` in `packages/server/src/import/service.ts`, and add its report kinds
   with their download hints to `REPORTS` in `packages/web/src/lib/imports.ts`.
6. **Charges:** add the broker's brokerage rules under `packages/core/rules/broker/<broker>/` (see
   [fee rules](../../docs/contributing/fee-rules.md)); statutory charges are shared.
7. **A user guide:** `docs/guides/<broker>.md`, like the Zerodha and Dhan ones, linked from the README.

## Template

```ts
// <Broker> adapter: <the reports it imports>; <the reports it recognises but v1 does not import>.
import type {
  AdapterInput,
  BrokerAdapter,
  Detection,
  FileProbe,
  ParseResult,
  ReportKind,
} from '../contract.js';

const HEADER = 'Date,Time,Symbol,ISIN,Side,Quantity,Price,Trade ID,Order ID'; // the tradebook's exact header

function detect(probe: FileProbe): Detection | null {
  if (probe.type !== 'text') return null;
  // Skip any metadata rows the broker writes above the header (never keep their contents).
  const header = probe.head.split(/\r?\n/).find((line) => line.startsWith('Date,'));
  return header === HEADER ? { kind: '<broker>.tradebook', confidence: 1 } : null;
}

function parse(input: AdapterInput, kind: ReportKind): ParseResult {
  if (kind === '<broker>.tradebook' && input.type === 'text') return parseTradebook(input.text);
  throw new Error(`<broker> adapter cannot parse ${kind} from ${input.type} input`);
}

export const brokerAdapter: BrokerAdapter = {
  broker: '<broker>',
  version: '1',
  reportKinds: ['<broker>.tradebook'],
  rejectedKinds: [],
  detect,
  parse,
};
```

`parseTradebook` reads the rows with `src/csv.ts`, converts money with `parseDecimalToMicro` and times with
`parseIstLocal`, builds each row's `dedupKey` from the broker's own trade and order IDs when it has them (Zerodha's
`zerodha:{exchange}:{trade_date}:{order_id}:{trade_id}`) or from a content hash plus an occurrence index when it has
none (Dhan), and returns rows, skipped rows and errors as described above. `src/zerodha/tradebook.ts` is the
smallest complete example.

## Good first adapters: Groww and Upstox (v1.1)

Both were planned from the start: the contract and the schema need no change for them. What is known so far:

- **Upstox:** its exports carry metadata rows above the header (account details), which must be skipped, never
  stored.
- **Groww:** its order history includes orders that were not executed; they are skipped with a reason, not imported.

Each needs real exports from someone with an account (anonymised by `pnpm fixtures:make`; the originals never leave
your machine), a NOTES file, the adapter with its tests, fee rules and a user guide. Open an issue before you start
so the work isn't duplicated.
