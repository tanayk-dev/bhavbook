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
