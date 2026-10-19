# Blueprint: BhavBook v1.0

- **Objective:** ship BhavBook v1.0 as specified in `docs/product/PRD.md`. It's a local-first trade journal for Zerodha and Dhan equity traders, run with `npx bhavbook`.
- **Created:** 2026-10-19 · **Revision:** 2 (after adversarial review) · **Status:** active
- **Mode:** S1 runs in direct mode (no repo yet); from S2 on, branch/PR (`gh` is authenticated).
- **Read before any step (sources of truth):**
  - `docs/product/PRD.md`: the capability contract. Key sections: §3 invariants, §5 states, §6 adapters, §7 reconstruction, §8 fees, §9 metrics, §10 data model, §13 decisions.
  - `docs/adr/README.md`: ADR-0001…0026. **ADR-0021 pins every package version; use exactly those.**
  - `.claude/rules/bhavbook/domain.md`: domain rules (they override generic ECC rules).
  - `docs/broker-exports/*/NOTES.md` and `docs/broker-exports/README.md`: real file formats and quirks. **Don't open the other files in `docs/broker-exports/`; they contain personal data. Use the fixtures from S2.**
- **Effort:** ~15.5 weeks at ~12 h/week (PRD §15).

---

## Invariants (verify after EVERY step)

1. `pnpm verify` passes. That runs lint, typecheck (every package), tests with coverage, the PII scan and the leak check; CI runs the same plus `format:check`. Vitest runs from the root config, which treats every package as a project.
2. **No floats for money:** the ESLint rule `bhavbook/no-float-money` passes in `packages/core` and `packages/adapters`. It bans `parseFloat(`, `Number(`, `.toFixed(` and `Math.round(`, plus a type-aware check that identifiers ending in `Micro` have type `bigint`.
3. **No personal data in git:**
   - `git ls-files docs/broker-exports | grep -vE '(\.md|\.gitkeep)$'` prints nothing.
   - `pnpm pii:scan` passes on `packages/*/fixtures/**`.
4. Coverage ≥ 80% overall, and **100% branches** for `packages/core/src/{money,fees,fifo}`.
5. **No outbound network** in app code: the `no-outbound-sockets` test passes from S11 on.
6. **Purity boundary:** `packages/core` and `packages/adapters` import nothing from `node:fs`, `node:net`, `better-sqlite3` or `packages/server`. This is checked by an ESLint `no-restricted-imports` rule from S1. All I/O (vault, workers, import orchestration, recompute persistence) lives in `packages/server`.
7. **TDD:** in steps touching `core` or `adapters`, the **first commit adds the failing tests** (golden, E-cases, properties), and the PR history shows red then green.
8. **Schema changes:** S4 owns `0001_init.sql`. Any later schema change ships `NNNN_<name>.sql` plus `fixtures/vault-v{N-1}.bhav` plus a migrate-forward test. Old migrations are never edited.
9. **ADRs:** any behaviour that contradicts an ADR is preceded by a new ADR that supersedes it.
10. **Outward-facing actions** (creating the GitHub repo, making it public, npm publish, tagging a release) require explicit user confirmation at that moment.

## Package layout (ADR-0021)

| Package | Contents | May do I/O? |
| :--- | :--- | :--- |
| `packages/core` | money, time, fifo, positions, adjustments, corporate actions, fees, reconciliation, analytics: **pure functions over plain data** | No |
| `packages/adapters` | broker parsers (pure: bytes in, data out) plus the contract | No (the spreadsheet *worker host* lives in server) |
| `packages/server` | `vault/` (SQLite, migrations, backup), `workers/` (spreadsheet worker host), `import/`, `recompute/`, `services/`, Hono app | Yes |
| `packages/web` | React UI | Browser only |
| `packages/cli` | `bhavbook` entry point (published as `bhavbook`) | Yes |

## Steps, dependencies and waves

| Step | Title | Depends on | Tier | Security review |
| :--- | :--- | :--- | :--- | :--- |
| S1 | Repo bootstrap and guardrails | — | default | — |
| S2 | Fixture pipeline and PII scanner | S1 | default | — |
| S3 | core: money and time primitives | S1 | **strongest** | — |
| S4 | Vault: schema 0001, migrations, backup/restore | S3 | default | **yes** |
| S5a | Adapter contract and spreadsheet worker | S2, S3 | default | **yes** |
| S5b | Zerodha parsers | S5a | default | — |
| S6 | Dhan parsers | S5a | default | — |
| S7-1 | Import pipeline: schema 0002, preview, commit | S4, S5b, S6 | default | **yes** |
| S7-2 | Import pipeline: undo, coverage | S7-1 | default | **yes** |
| S8 | Instrument resolution | S7 | default | — |
| S9 | Reconstruction core | S8 | **strongest** | — |
| S10a | Adjustments and opening-lot suggestions | S9 | **strongest** | — |
| S10b | Corporate actions | S9 | **strongest** | — |
| S10c | Journal anchors | S10a | default | — |
| S11 | Server and CLI | S4 | default | **yes** |
| S12a | Fee rules and engine | S9 | **strongest** | — |
| S12b | Reconciliation and FIFO cross-check | S12a, S10a | **strongest** | — |
| S13a | Web shell, onboarding, settings | S7, S11 | default | **yes** |
| S13b | Import wizard and coverage view | S13a | default | — |
| S13c | Issues inbox | S13b, S10a, S10b, S12b | default | — |
| S14a | Review queue, position detail, journal, screenshots | S13c, S10c | default | **yes** |
| S14b | Corporate actions UI and diagnostics export | S13c | default | — |
| S15a | core analytics | S12b, S10c | default | — |
| S15b | Dashboard (EvilCharts) | S15a, S14a | default | — |
| S16 | Packaging, E2E, sanitizer, launch | S14b, S15b | default | **yes** |

```
W1  S1
W2  S2 ∥ S3
W3  S4 ∥ S5a
W4  S5b ∥ S6 ∥ S11
W5  S7-1 → S7-2
W6  S8
W7  S9
W8  S10a ∥ S10b ∥ S12a ∥ S13a
W9  S10c ∥ S12b ∥ S13b
W10 S13c ∥ S15a
W11 S14a ∥ S14b
W12 S15b
W13 S16
```

**Branch/PR convention (S2 on):**
- Branch: `feat/<step-id>-<slug>`; Conventional Commits; PR title `<step-id>: <title>`.
- Squash-merge only after all of these:
  - CI green on Ubuntu, Windows and macOS;
  - `ecc:code-reviewer` and `ecc:typescript-reviewer` report no CRITICAL or HIGH findings;
  - `ecc:security-reviewer` where the table says so.
- **Rollback:** revert the squash commit. A schema rollback ships a new corrective migration (invariant 8).
- **Split rule:** a PR over ~800 changed lines (fixtures excluded) is split per the mutation protocol before merging.

---

## S1: Repo bootstrap and guardrails

**Context:**
- The workspace `C:\Users\tanay\Documents\WorkSpace\bhavbook` has only `docs/` and `.claude/`, and no git yet.
- `docs/broker-exports/**` contains real broker files with partial personal data. They are **never committed**; only `*.md` and `.gitkeep` are.
- Versions come from ADR-0021, including:
  - Node 24.22.0, pnpm 12.14.0, **TypeScript 6.0.3**;
  - ESLint 10.13.0, typescript-eslint 8.71.2, Prettier 3.9.10;
  - Vitest and @vitest/coverage-v8 5.0.5, fast-check 4.10.2, tsx 4.23.15, @types/node 24.19.2.
- Licence MIT (ADR-0026).

**Tasks:**
1. `git init -b main`. `.gitignore`: `node_modules/`, `dist/`, `coverage/`, `*.bhav` (except `**/fixtures/*.bhav`), `*.db`, `*.db-*`, `.env*`, plus:
   ```
   docs/broker-exports/**
   !docs/broker-exports/**/
   !docs/broker-exports/**/*.md
   !docs/broker-exports/**/.gitkeep
   ```
2. `.nvmrc` = `24.22.0`. Root `package.json`:
   - `"private": true`, `"packageManager": "pnpm@12.14.0"`, `"engines": {"node": ">=24.11"}`;
   - scripts `lint`, `typecheck`, `test`, `e2e`, `pii:scan` (the scan is a placeholder that exits 0 until S2).
3. `pnpm-workspace.yaml`: `packages/*` and `tools/*`; `minimumReleaseAge: 4320`. Create `packages/{core,adapters,server,web,cli}` with `package.json` (`@bhavbook/<name>`; cli is published as `bhavbook`) and `src/index.ts`. Exact-pin root dev dependencies per ADR-0021.
4. `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `target ES2023`, `module NodeNext`, `verbatimModuleSyntax`. Each package gets its own `tsconfig.json` extending it.
5. ESLint flat config (typescript-eslint type-checked plus Prettier). The local plugin `tools/eslint-plugin-bhavbook` has:
   - `no-float-money`, applied to `packages/core/**` and `packages/adapters/**` (invariant 2);
   - `no-restricted-imports` for the purity boundary (invariant 6).

   The rules have their own tests (valid and invalid cases).
6. Vitest workspace with v8 coverage: global threshold 80%; 100% branches for `packages/core/src/{money,fees,fifo}/**` (globs that match nothing are allowed).
7. `.github/workflows/ci.yml`:
   - matrix `ubuntu-latest, windows-latest, macos-latest`, Node from `.nvmrc`;
   - `pnpm install --frozen-lockfile`, then lint, typecheck, test and pii:scan;
   - **a leak check:** `git ls-files docs/broker-exports | grep -vE '(\.md|\.gitkeep)$' && exit 1 || true`.
8. `LICENSE` (MIT, 2026, the project author). `README.md` stub (one-liner, "pre-alpha", links to the PRD, ADRs and this plan). `CONTRIBUTING.md` (ADR process, fixture/PII rules, TDD invariant).
9. Commit `chore: bootstrap monorepo and guardrails`.
10. **Ask the user** before `gh repo create bhavbook --private --source . --push`. It stays private until S16.

**Verification:**
```bash
corepack enable && pnpm install && pnpm verify
git ls-files docs/broker-exports | grep -vE '(\.md|\.gitkeep)$' && echo LEAK || echo OK
git check-ignore -q docs/broker-exports/dhan/tax-report/x.xls && echo ignored
```

**Exit criteria:**
- CI green on 3 OSes.
- The rule tests prove that `parseFloat` and a `node:fs` import inside `core` are rejected.
- The leak check prints OK.

---

## S2: Fixture pipeline and PII scanner

**Context:**
- Adapter tests need anonymised real-format files (domain.md: "no real PAN, client ID, or names").
- Known leftovers in the originals (`docs/broker-exports/README.md`):
  - the Dhan trade-file name contains the client ID;
  - the Dhan Journal CSVs contain the real first name in the `Name,` row;
  - the Dhan `.xls` has partly masked mobile and email.

**Tasks:**
1. `tools/make-fixtures.ts` reads `docs/broker-exports/**` (locally only; the originals are gitignored) and writes `packages/adapters/fixtures/<broker>/<kind>/…`:
   - **File names:** tokens that look like client IDs become `XX0000` (Zerodha) or `XXXX00000X` (Dhan).
   - **CSV:** the values of the metadata rows `Name,`, `UCC,`, `Mobile,` and `Email ID,` are replaced with `TEST USER`, `XXXX00000X`, `1234567890` and `test@example.com`. These are **byte-level edits only**: every other byte is unchanged.
   - **XLS/XLSX:** via SheetJS 0.20.3 (CDN tarball per ADR-0023), replace header-block cells (Client ID, Client Name/Name, PAN, UCC, Mobile, Email) and `Clt <id>` inside narrations. Keep sheet names, cell types and number formats; write `.xls` back as BIFF8.
   - **Fidelity rule:** CSV must be byte-equal except for the replaced values. XLS/XLSX must have equal cell values in every non-PII cell (asserted by a test that diffs the cells).
2. Kinds to produce:
   - Zerodha: `tradebook`, `tax_pnl`, `agts`, `pnl`.
   - Dhan: `trade_history`, `global_transactions`, `dp_charges`, `tax_report`, `pnl`, `realised_pnl`, `ledger`, `fund_summary`.
3. `tools/pii-scan.ts` scans text, CSV and XLS/XLSX cells (via SheetJS) for:
   - PAN `\b[A-Z]{5}\d{4}[A-Z]\b`, except `XXXXX0000X`;
   - email `[\w.+-]+@[\w-]+\.[\w.]+`, except the allowlist `*@dhan.co`, `*@zerodha.com`, `test@example.com`;
   - 10-digit numbers `\b\d{10}\b`, except `1234567890`, and except numeric cells in trade or bill-number columns, allowlisted by column header;
   - `Clt\s+\S+` other than `Clt XXXX00000X`;
   - every entry in an optional **denylist file outside the repo** (`~/.bhavbook-pii-denylist`, one term per line, case-insensitive). The author keeps their real name and IDs there; it's never committed, and CI runs without it.

   Wire it to `pnpm pii:scan`.
4. `packages/adapters/fixtures/MANIFEST.md`: one row per fixture (kind, period, rows, source note).
5. Run the `ecc:opensource-sanitizer` agent on `packages/adapters/fixtures` → PASS is required.

**Verification:** `pnpm tsx tools/make-fixtures.ts && pnpm pii:scan` (with the local denylist) → 0 findings; `pnpm --filter tools test` (fidelity tests).

**Exit criteria:** all 12 kinds have fixtures; scanner and sanitizer PASS.

---

## S3: core money and time primitives (strongest)

**Context:** ADR-0004 and ADR-0005, plus domain.md Money and Time. Money is a `bigint` count of micro-rupees (₹1 = 1,000,000); rates are bigint rationals. **No decimal library, no floats.** Every later step uses this API.

**Tasks** (`packages/core/src/money`, `packages/core/src/time`). Tests first (invariant 7):
1. `parseDecimalToMicro(s, opts?: {round?: RoundingMode}) → bigint`:
   - accepts `^\s*-?\d+(\.\d+)?\s*$`;
   - more than 6 fractional digits without `round` raises a typed `PrecisionError`.
2. `roundMicro(x, unit: 'paisa' | 'rupee' | bigint, mode: 'half-up' | 'half-even' | 'floor' | 'ceil')`.
3. `normaliseDecimalString(s, dp, mode) → string`, e.g. `"700.599976"` → `"700.60"` (ADR-0010).
4. `Rate` rational: `rateFromPercentString("0.00297%")`, `rateFromDecimalString("0.18")`, and `applyRate(amountMicro, rate, mode) → bigint`, exact.
5. `allocateLargestRemainder(total, weights: bigint[]) → bigint[]`: the parts sum exactly to `total`; ties go to the lower index.
6. `formatINR(micro, {dp: 2})` → `₹1,23,456.78`. This is the only place display rounding happens.
7. Time, using a **fixed +05:30 offset (IST has no DST); no Temporal:**
   - `parseIstLocal('2025-09-12T14:50:01') → utc ISO`;
   - `istDateOf(utcIso) → 'YYYY-MM-DD'`;
   - `istDayBounds(date)`;
   - `holdingDays(entryDate, exitDate)`;
   - `formatIstDate(date) → 'dd MMM yyyy'`.
8. Property tests (fast-check):
   - parse → format round-trip at 6 dp;
   - allocation sums;
   - `applyRate` is monotonic;
   - no overflow or exception up to ±10^15 rupees.

   Every time test also runs under `TZ=America/New_York`.

**Verification:** `pnpm --filter @bhavbook/core test -- --coverage` (100% branches in `money/`); `TZ=America/New_York pnpm --filter @bhavbook/core test`.

**Exit criteria:** the API is documented in `packages/core/README.md`; E9 and E10 conversions (PRD §7.5) pass.

---

## S4: Vault (schema 0001, migrations, backup/restore) [security review]

**Context:**
- ADR-0003: better-sqlite3 13.0.3, `STRICT`, WAL, `safeIntegers: true`.
- ADR-0020 (backups), ADR-0019 (**no file names, client IDs or metadata stored**) and PRD §10.
- Lives in `packages/server/src/vault`, because it does I/O (invariant 6).

**Tasks:** tests first.
1. A migration runner: files `migrations/NNNN_<name>.sql` are applied in order inside a transaction and recorded in `schema_migrations(version, applied_at)`. It takes an automatic backup before migrating.
2. `0001_init.sql`: every table is `STRICT`; money columns are `*_micro INTEGER`; IDs are `TEXT` (ULID via `ulid` 3.0.2). Columns needed by later steps are included now (no later migration is expected in v1):
   - `pan_entity(id, label)`, `profile(id, pan_entity_id, name)`
   - `broker_account(id, profile_id, broker, nickname)` (**no client ID column**)
   - `import_batch(id, account_id, file_sha256, report_kind, adapter_version, coverage_from, coverage_to, counts_json, status, created_at)` (**no file_name**)
   - `raw_row(id, batch_id, line_no, raw_text)`
   - `trade_row(id, account_id, batch_id, raw_row_id, dedup_key, granularity, source, external_order_id, executed_at_utc, trade_date_ist, side, quantity, price_micro, trade_value_micro, value_authority, exchange, isin, broker_symbol, broker_name, product_declared, flags_json)` + `UNIQUE(account_id, dedup_key)`
   - `statement_row(id, batch_id, account_id, kind, key_json, data_json, dedup_key)` + `UNIQUE(account_id, kind, dedup_key)`
   - `instrument(id, isin UNIQUE NULL, display_name)`, `instrument_alias(id, broker, alias, instrument_id, source, created_at)`
   - `corporate_action(id, type, isin, new_isin, ex_date, ratio_num, ratio_den, cost_split_bp, created_at, status)`
   - `adjustment(id, account_id, type, payload_json, source, status, superseded_by, created_at)` (status ∈ active, reverted, superseded)
   - `journal_entry(id, anchor_account_id, anchor_instrument_id, anchor_bucket, anchor_key, status, setup_tag_id, thesis, planned_stop_micro, initial_stop_micro, planned_target_micro, planned_risk_micro, review_note, reviewed_at, created_at, updated_at)` (status ∈ attached, unattached)
   - `tag(id, kind, name)`, `journal_tag(journal_entry_id, tag_id)`
   - `attachment(id, journal_entry_id, mime, data BLOB CHECK(length(data) <= 1048576), created_at)`
   - `setting(key PRIMARY KEY, value)` (e.g. `breakeven_threshold_micro`)
   - `issue(id, account_id, kind, subject_json, status, created_at, resolved_at)`
   - Derived (rebuilt by recompute): `fill_allocation`, `lot`, `position`, `fill_charge`, `charge_reconciliation`
3. Repositories: typed functions per aggregate (Kysely 0.29.7 allowed). Money is read and written as `bigint`.
4. Backup (`.bhav`):
   - **create:** `VACUUM INTO <tmp>`, then `manifest.json` (`schema_version`, `app_version`, `sha256` of the db bytes), then a single-file container `BHAV1 | u32 manifest_len | manifest | db_bytes`. Auto-backups rotate (keep 10); pre-migration backups are kept separately.
   - **restore:** check the magic and lengths (reject a manifest over 64 KB, or a db larger than the file), verify the SHA-256, write to a temp path in the vault directory (**no paths taken from the archive**), migrate forward, then atomically rename it into place.
5. Commit `packages/server/fixtures/vault-v0001.bhav` (an empty schema-0001 vault) for future migration tests. Tests:
   - create → restore round-trip;
   - corrupted hash rejected;
   - truncated or oversized container rejected;
   - inserting REAL into a `_micro` column fails;
   - every table's `sql` in `sqlite_schema` contains `STRICT`;
   - bigint round-trip above 2^53.

**Verification:** `pnpm --filter @bhavbook/server test`.

**Exit criteria:** green on 3 OSes; the security review shows no CRITICAL or HIGH findings.

---

## S5a: Adapter contract and spreadsheet worker [security review]

**Context:**
- ADR-0008 (pure adapters; fill-or-order rows; value authority), ADR-0009 (dedup keys), ADR-0023 (SheetJS 0.20.3 from the CDN, worker, limits) and PRD §6.1–§6.3.
- Adapters stay pure. They receive **already-parsed sheet data** (`SheetData = {name, rows: (string | number | null)[][]}[]`) or CSV text.
- The worker host that turns bytes into `SheetData` lives in `packages/server/src/workers` (invariant 6).

**Tasks:** tests first.
1. `packages/adapters/src/contract.ts` defines:
   - `BrokerId`, `ReportKind`, `FileProbe` (first 64 KB of text, or sheet names plus the first 20 rows);
   - `Detection {kind, confidence}`;
   - `BrokerAdapter {broker, reportKinds, rejectedKinds, detect, parse}`;
   - `ParseResult {rows, statements?, instrumentHints?, skipped, errors, coverage}`;
   - `CanonicalRow` (exactly the PRD §6.2 fields plus `source ∈ {tradebook, external}`);
   - `StatementRow`, `InstrumentHint`;
   - `SkippedRow {line, reason ∈ fno | currency | commodity | mf | not_traded | other}`;
   - `RowError {line, code}` (**never cell values**);
   - `RejectedKind {kind, message}`.

   Write zod 4.6.7 schemas for each.
2. `packages/adapters/CONTRACT.md`: contributor guide (purity, fixtures, golden tests, dedup key, no PII in output).
3. `packages/server/src/workers/spreadsheet.ts`: a `worker_thread` running SheetJS with:
   - input ≤ 25 MB, ≤ 200,000 rows total, 10 s timeout (the worker is killed when it's exceeded);
   - `cellFormula: false`, cached values only, no external links.

   The output is `SheetData`.
4. Tests: oversized, slow (synthetic) and malformed files are rejected cleanly; zod validates a sample `ParseResult`.

**Verification:** `pnpm --filter @bhavbook/adapters test && pnpm --filter @bhavbook/server test`.

**Exit criteria:** the contract is merged; the security review is clean.

---

## S5b: Zerodha parsers

**Context:** `docs/broker-exports/zerodha/NOTES.md`; fixtures from S2; contract from S5a.
- **Tradebook header:** `symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time`.
- Prices are float32 artefacts. Times are IST with no zone. The ISIN is sometimes blank. Quantity looks like `10.000000`. `order_id` is a 16–19 digit string.
- **External tradebook** (Console segment "Equity (external trades)"): same format, `source=external`. **No sample yet**, so write a skipped test with a TODO.

**Tasks:** tests first.
1. `zerodha/tradebook.ts`:
   - `detect` uses the exact header (the external variant if its header or segment differs; to be confirmed once a sample exists).
   - `parse` produces:
     - `dedup_key = zerodha:{exchange}:{trade_date}:{order_id}:{trade_id}`;
     - price via `normaliseDecimalString(price, 2, 'half-up')` → `price_micro`;
     - `trade_value_micro = qty × price_micro`;
     - `granularity: 'fill'`, `value_authority: 'price'`, `product_declared: null`;
     - `flags.auction`;
     - a non-integer quantity → `RowError(non_integer_qty)`;
     - non-EQ segments → skipped with a reason;
     - raw text and line passed through.
2. `zerodha/tax-pnl.ts` (from `SheetData`) → `StatementRow`s:
   - `kind: 'zerodha.tax_pnl.lot'`, with per-component charges (4 dp → micro via `parseDecimalToMicro`);
   - plus "Other Debits and Credits" DP rows.
   - **No header-block values in the output** (test asserts it).
3. **Rejected kinds:** `zerodha.agts` and `zerodha.pnl`. `detect` recognises them, and the import is refused with "useful later, not needed in v1" (PRD §6.3). Add one message test per kind.
4. **Test-only golden reader** at `packages/adapters/test/golden/zerodha-agts.ts`: it parses the AGTS fixture for tests only and is not exported.
5. Golden tests:
   - 121 fills, 27 symbols;
   - Σ normalised buy and sell values per (symbol, exchange) **exactly equal** the AGTS for all 32 rows;
   - the two blank-ISIN fills (FIVESTAR, ADVANCE) come out with `isin: null`;
   - E10 passes.

**Verification:** `pnpm --filter @bhavbook/adapters test -- --coverage`.

**Exit criteria:** the AGTS equality test is green.

---

## S6: Dhan parsers

**Context:** `docs/broker-exports/dhan/NOTES.md`; contract from S5a.
- **Trade history header:** `Date,Time,Name,Buy/Sell,Order,Exchange,Segment,Quantity/Lot,Trade Price,Trade Value,Status`, newest first.
  - No IDs or ISIN.
  - `Trade Value` is authoritative (16 of 116 rows have `qty × price ≠ value`).
  - `Order` ∈ {DELIVERY, INTRADAY, MTF}.
- **Journal CSVs** follow this layout: a metadata block (**must not appear in output**), header, quoted rows, a blank line, a summary key/value line, a blank line, then `NOTE : …` with no trailing newline. Date formats are mixed: `dd Mon yyyy`, `dd-mm-yyyy`, `dd Mon yyyy HH:MM:SS`, `mm/dd/yyyy`.
- **Tax Report** is `.xls` (BIFF), passed as `SheetData` with 8 sheets. Parse by header name; float cells go to paise (`normaliseDecimalString(String(v), 2, 'half-up')`).

**Tasks:** tests first.
1. `dhan/journal-csv.ts`: locate the header by known columns, read data to the first blank line, parse the summary pairs, and **drop the metadata block before returning** (a test asserts that the output never contains `Name`, `UCC`, `Mobile` or `Email ID` values).
2. `dhan/trade-history.ts`:
   - `dedup_key = sha256(date|time|name|side|order|exchange|qty|value)` + `#<occurrence index of identical tuples in this file>`;
   - `granularity: 'order'`, `value_authority: 'value'`;
   - `product_declared` from `Order`;
   - `Status ≠ Traded` → skipped `not_traded`.
3. `dhan/global-transactions.ts`, `dhan/dp-charges.ts` and `dhan/tax-report.ts` → `StatementRow`s (`dhan.gt.row`, `dhan.dp.row`, `dhan.tax.lot`) and `InstrumentHint`s (statement name → ISIN). The Tax Report lots include the IPO lot (Bajaj Housing, 200 @ ₹176, 17-09-2024).
4. **Rejected kinds:** `dhan.pnl`, `dhan.realised_pnl`, `dhan.ledger`, `dhan.fund_summary`, with message tests.
5. Test-only golden reader `packages/adapters/test/golden/dhan-pnl.ts` (used later by S15a).
6. Golden tests:
   - 116 rows, 42 names;
   - no duplicate keys;
   - the 8 multi-row (day, scrip, side) groups keep distinct keys;
   - the Tax Report Equity sheet yields all intraday (11) and delivery lots;
   - E9 passes.

**Verification:** `pnpm --filter @bhavbook/adapters test`.

**Exit criteria:** all Dhan v1 kinds parse; the metadata-absence test is green.

---

## S7: Import pipeline [security review]

**Context:**
- PRD §5.1 (batch states and preview contents), ADR-0007 (immutable raw), ADR-0009 (idempotency) and ADR-0019 (no file names or IDs stored).
- Lives in `packages/server/src/import` and uses the vault (S4), the worker (S5a) and the adapters (S5b, S6).
- Wrong-account heuristic: the file's range overlaps the account's coverage but shares **less than 10%** of the dedup keys in the overlap.

**Tasks:** tests first.
1. `previewImport(accountId, files: {bytes}[])`:
   - detect each file; an ambiguous detection returns candidates; a rejected kind returns its message;
   - parse via the worker or CSV text;
   - compute counts (new, duplicate, skipped-by-reason, errors), coverage, wrong-account warnings, and an **issue forecast** by dry-running recompute on a copy-on-write in-memory view (once S9 exists; before that, the forecast is empty);
   - write nothing; return a preview token with a 15-minute TTL.
2. `commitImport(token)`: auto-backup, then **one transaction** inserting `import_batch`, `raw_row` and `trade_row`/`statement_row` (`ON CONFLICT DO NOTHING`), then trigger a recompute (a no-op hook until S9).
3. `undoImport(batchId)` **(S7-2)**: delete exactly that batch's rows, then recompute.
   - **Overlap rule (found in S4):** `trade_row`/`statement_row` keep one row per dedup key, so a later overlapping batch inserts nothing for keys it shares with an earlier batch. Undoing the *earlier* batch would lose those rows. In the same transaction, re-insert the deleted keys from the earliest surviving batch's `batch_row` copy (schema 0002, see r5). Test: import A, import overlapping B, undo A → B's overlapping trades are still present.
4. `coverage(accountId)` **(S7-2)**: merged ranges per report kind, plus gaps.
5. Tests:
   - re-import → 0 new rows;
   - overlapping Zerodha windows deduplicate;
   - overlapping whole-day Dhan files deduplicate;
   - undo restores the earlier state (compare a hash of the tables);
   - the wrong-account warning fires on the constructed case;
   - **no original file name is stored anywhere** (scan every TEXT column for the input name);
   - a property test over random file subsets and orders gives identical final row sets (PRD §3.2 invariant 4);
   - a benchmark: 5,000 rows in under 5 s (warns on CI, fails locally only with `BENCH=1`).

**Verification:** `pnpm --filter @bhavbook/server test`.

**Exit criteria:** idempotency property green; security review clean.

---

## S8: Instrument resolution

**Context:**
- ADR-0014. Order: ISIN in the row → **transaction join** → learned alias → manual.
- The join matches a Dhan trade-file (date, name) day aggregate of (buy qty, sell qty) against a `dhan.gt.row` with the same date and quantities, takes that row's statement name, and gets the ISIN from `InstrumentHint`s (Tax Report or DP Charges).
- On real FY 2024-25 data the join resolves 36/36 names (exact-name matching: 34/36). There is no bundled security master.
- Zerodha blank ISINs are filled from the same symbol elsewhere in the file or vault.
- Pure matching lives in `packages/core/src/instruments`; persistence lives in `packages/server/src/services/instruments.ts`.

**Tasks:** tests first.
1. `core`: `resolveAliases(tradeAggregates, statementRows, hints, knownAliases) → {resolved[], unresolved[]}`. It's pure and deterministic, and ambiguous matches go to unresolved.
2. `server`: `resolveInstruments(accountId)` writes `instrument` and `instrument_alias` (source ∈ file, join, learned, manual) and raises `issue(unresolved_instrument)`. `mapInstrumentManually(aliasId, isin | {newDisplayName})` uses suggestions ranked by normalised token overlap.
3. Tests:
   - 36/36 FY 2024-25 Dhan names resolve with 0 ambiguity;
   - "Rural Electrification Corporation" → REC's ISIN and "HCC" → Hindustan Construction's ISIN via the join;
   - the Zerodha FIVESTAR/ADVANCE blank ISINs are filled;
   - re-running gives the same result (idempotent).

**Verification:** `pnpm --filter @bhavbook/core test && pnpm --filter @bhavbook/server test`.

**Exit criteria:** 0 unresolved names in the FY 2024-25 fixture period.

---

## S9: Reconstruction core (strongest)

**Context:**
- ADR-0011: FIFO key = (account, instrument, bucket); exchange excluded.
- ADR-0012: same-day netting. Per (account, instrument, IST date), `intraday_qty = min(bought, sold)`, buys matched against the **earliest** sells first. That quantity goes to INTRADAY for every broker and declared product. The remainder keeps its declared product (Dhan DELIVERY/MTF) or becomes DELIVERY (Zerodha, or a Dhan INTRADAY remainder).
- ADR-0007: pure recompute.
- PRD §7.1–§7.3, E1–E5, E11 (without the opening lot) and E12.
- Orphan sells → INCOMPLETE. Holdings never go negative.
- Pure logic in `packages/core/src/{fifo,positions}`; orchestration in `packages/server/src/recompute`.

**Tasks:** tests first.
1. `groupFillsIntoOrders(rows)`: for `granularity = fill`, group by `external_order_id` (needed for per-order brokerage in S12a). Order-granularity rows pass through.
2. `allocateBuckets(rows, overrides) → FillAllocation[]`:
   - a fill can split across buckets;
   - Zerodha allocations get `HAS_INFERRED_PRODUCT`;
   - `overrides` is the `product_override` adjustment input (empty until S10a; the interface is defined here).
3. `matchFifo(allocations) → Lot[]` per (account, instrument, bucket):
   - sorted by `executed_at_utc`, then `dedup_key`;
   - values from `trade_value_micro`, split proportionally with `allocateLargestRemainder`.
4. `buildPositions(lots, orphans) → Position[]`: 0→n→0 runs; orphan quantity → INCOMPLETE.
5. `server/recompute(accountId)`: load rows, call the core functions, and replace the account's derived tables in one transaction. The output is **byte-identical** across runs. Wire it into S7's hook and the preview issue forecast.
6. Golden tests:
   - **Dhan FY 2024-25:** our lots equal the Tax Report tradewise lots (by ISIN, buy and sell date, qty, and value to the paisa). The exception is the 200-share IPO lot, which must appear as an orphan on 18 Sep 2024.
   - **Zerodha:**
     - exactly 10 INCOMPLETE positions from the 2025-09-12 orphan sells;
     - the 3 same-day round trips (ARIHANTCAP, ARSSBL, ADVENTHTL) are INTRADAY;
     - each of the 5 NSE→BSE symbols forms one position.
   - E1–E5 and E12.
   - Instrument re-keying: resolving a Dhan alias after positions exist re-keys them with no duplication.
   - Properties: no negative holdings; no cross-account or cross-bucket matching; recompute is idempotent.
7. Benchmark: recompute of 20k synthetic rows in under 3 s (warn on CI).

**Verification:** `pnpm --filter @bhavbook/core test -- --coverage` (100% branches in `fifo/`) and `pnpm --filter @bhavbook/server test`.

**Exit criteria:** the Dhan lot-equality golden test is green.

---

## S10a: Adjustments and opening-lot suggestions (strongest)

**Context:**
- ADR-0013 and PRD §5.2/§5.5, E6, E7 and E11.
- Adjustments are `adjustment` rows (`opening_lot` | `exclude` | `product_override`), with `source ∈ manual, broker_statement` and `status ∈ active, reverted, superseded`. They can be reverted and **never edit imported rows**.

**Tasks:** tests first.
1. `core`: apply active adjustments inside reconstruction:
   - `opening_lot {instrument, bucket, qty, total_cost_micro, entry_date | before_date}` becomes a synthetic entry allocation with `source=adjustment:<id>`;
   - `exclude {position anchor}`;
   - `product_override {instrument, date, bucket}`.
2. `core`: `suggestOpeningLots(orphans, statementLots)`: match by ISIN and qty, with entry date ≤ the orphan sell date, preferring an exact qty match. Output suggestions only.
3. `server`: raise `issue(fill_from_statement)` with accept/dismiss actions. Accepting creates `adjustment(source=broker_statement)`.
4. `server`: after each import, if real fills now cover a quantity backed by an active opening lot, raise `issue(opening_lot_redundant)` with a "replace" action that sets the adjustment's status to `superseded` (E7). Never automatic.
5. Golden tests:
   - **E11 full:** accepting the Dhan Tax Report IPO lot gives a complete delivery position with gross −₹390 (and the intraday leg stays −₹750);
   - E6 and E7;
   - Zerodha's 10 INCOMPLETE positions all become complete via manual opening lots;
   - revert restores INCOMPLETE.

**Verification:** `pnpm --filter @bhavbook/core test && pnpm --filter @bhavbook/server test`.

**Exit criteria:** all of the above green.

---

## S10b: Corporate actions (strongest)

**Context:** ADR-0015 and PRD §7.4, E8.
- `SPLIT` qty × ratio, cost and date unchanged.
- `BONUS`: new lots at ₹0 cost, dated at allotment (s.55(2)(aa)).
- `CONVERSION`: old ISIN → new ISIN at a ratio; cost and dates carried over.
- `DEMERGER`: child lots at a ratio; cost split in basis points; the child inherits the parent's date.

**Tasks:** tests first.
1. `core`: apply `corporate_action` rows to open lots at the ex-date, inside reconstruction. Fractional entitlements are floored; the fraction is reported for the user to record any cash-in-lieu sale.
2. `core`: `previewCorporateAction(action, lots)` → the before/after table of affected lots.
3. `core`: two suspicion heuristics → issue suggestions:
   - (a) an orphan sell qty that is an integer multiple (≥ 2) of the quantity held at that moment, which suggests a missed split or bonus;
   - (b) an instrument with open quantity that has no trades or statement rows after a date, while a new ISIN appears with similar quantity, which suggests a conversion or demerger.
4. Golden tests:
   - E8;
   - bonus 1:1 → the new lot has cost 0 and the allotment date, and the position average halves;
   - Tata demerger example (100 @ ₹800; 68.85/31.15) → TMPV ₹55,080 and TMCV ₹24,920, total preserved, dates inherited;
   - conversion moves lots;
   - revert restores.

**Verification:** `pnpm --filter @bhavbook/core test`.

**Exit criteria:** all green; 100% branches in the corporate-actions module.

---

## S10c: Journal anchors

**Context:** ADR-0018 and PRD §10.1. A journal entry stores the anchor (account, instrument, bucket, `anchor_key` = the opening entry's dedup key or `adjustment:<id>`). It's re-attached after every recompute and is never deleted by one.

**Tasks:** tests first.
1. `server/recompute`: after building positions, re-attach every `journal_entry` to the position containing its anchor.
   - If the anchor is gone, `status = unattached` and `issue(journal_unattached)`.
   - If two entries land on one position, `issue(journal_collision)` with merge/keep-both actions.
2. Tests:
   - an entry survives an older-history import that merges an INCOMPLETE position into a complete one;
   - undoing the import that contained the anchor fill → unattached;
   - re-importing it → re-attached.

**Verification:** `pnpm --filter @bhavbook/server test`.

**Exit criteria:** green.

---

## S11: Server and CLI [security review]

**Context:**
- ADR-0001 (`npx bhavbook`, 127.0.0.1 only, no outbound calls) and ADR-0002 (per-launch 256-bit token; HttpOnly SameSite=Strict cookie; Host and Origin allowlist on **every** HTTP and WebSocket route via one middleware).
- Hono 4.13.13, @hono/node-server 2.1.5, open 11.0.4.

**Tasks:** tests first.
1. `packages/server/src/app.ts`:
   - Hono with the security middleware registered first;
   - a typed RPC route tree for vault, import, coverage, issues, positions, journal, settings and analytics. **Handlers not yet implemented return 501** and are wired by the step that builds the service;
   - money serialised as decimal strings;
   - zod-validated inputs;
   - static serving of the web build.
2. **Logging and error policy:** the error handler and logger never include request bodies, file contents or cell values (ADR-0019). A test sends a body with a marker string, triggers an error, and asserts the marker is absent from logs and from the response.
3. `packages/cli`:
   - `bhavbook [--vault <path>] [--port <n>]`;
   - default vault `~/BhavBook/vault.db` (on Windows, `%USERPROFILE%\BhavBook\vault.db`);
   - a random free port, bound to `127.0.0.1` only;
   - opens `http://127.0.0.1:<port>/?t=<token>`;
   - subcommands `backup <out>`, `restore <file>`, `doctor` (Node version ≥ 24.11, better-sqlite3 loads, `PRAGMA integrity_check`).
   - **Single-instance vault lock (from the S4 review):** hold a lock file (`<vault>.lock`, O_EXCL with the PID) for the server's lifetime, so a restore or a second `npx bhavbook` can't touch an open vault. `restore` takes the same lock for the whole verify-and-swap.
   - **Startup recovery (from the S4 review):** if the vault file is missing but a `.<vault>.old-*.tmp` exists (a crash mid-swap), move it back, plus its sidecars, before opening. Delete stale `.restore-*/.rebuilt-*/.snapshot-*` temp files.
4. Tests:
   - no token → 401;
   - foreign `Host` → 403;
   - foreign `Origin` → 403;
   - WebSocket upgrade with a bad Origin is rejected;
   - the bound address is `127.0.0.1`;
   - **`no-outbound-sockets`:** a global test setup patches `net.connect`, `tls.connect`, `http(s).request` and `fetch`, and fails on any non-loopback target. It's enabled for every package's tests from this step on.

**Verification:** `pnpm --filter @bhavbook/server test && pnpm --filter bhavbook test`; manual: `pnpm tsx packages/cli/src/index.ts --vault ./tmp/v.db` opens the browser.

**Exit criteria:** security tests green; security review clean.

---

## S12a: Fee rules and engine (strongest)

**Context:**
- ADR-0016:
  - contract note = (account, IST date, exchange);
  - STT and stamp duty computed on the contract note's turnover per charge class and **rounded half-up to the rupee**;
  - brokerage per executed order (uses S9's `groupFillsIntoOrders`; Dhan order rows are already orders);
  - txn, SEBI and IPFT on turnover at paise;
  - GST 18% of (brokerage + txn + SEBI + IPFT);
  - DP per (ISIN, delivery sell day);
  - totals allocated to fills by value (largest remainder).
- Evidence (PRD research A1): this reproduces Dhan STT on 45/46 days and stamp duty on 46/46.
- Charge classes come from S9's buckets (same-day netted = intraday, including E12 MTF).
- MTF: delivery-like statutory charges plus broker MTF brokerage. **Interest is not modelled** (positions are labelled with the flag `mtf_interest_excluded`).

**Tasks:** tests first.
1. A zod schema for the rule files and JSON files in `packages/core/rules/statutory/{nse,bse}/<effective-date>.json` and `packages/core/rules/broker/{zerodha,dhan}/<effective-date>.json`.
   - Rates are exact decimal strings, each with a `source_url` and `verified_on`.
   - Initial versions must cover FY 2024-25 → today, including NSE txn 0.00322% before 2024-10-01 and 0.00297% from then (later revisions as published by the source).
   - Every rate is the exact value from its cited source (**no approximations**). The golden tests decide whether a version is correct.
2. `computeCharges(orders, allocations, rules) → FillCharge[]` (pure). The rule version is selected by trade date.
3. Brokerage rules:
   - Zerodha: delivery 0; intraday min(0.03%, ₹20) per order; MTF min(0.3%, ₹20).
   - Dhan: delivery 0; intraday and MTF min(0.03%, ₹20).
   - DP: Zerodha ₹15.34 (and the earlier ₹15.93 version); Dhan ₹12.50 + GST.
4. Position-level override `mtf_brokerage_override` for Zerodha MTF trades, which the tradebook can't identify. It's an `adjustment(type=product_override)` variant that sets the bucket to MTF.
5. Golden tests:
   - **Dhan FY 2024-25:** every day's STT and stamp duty equal Global Transactions exactly; other components within ±₹0.01 per (date, scrip). The one exception is **18 Sep 2024**, which needs the IPO opening lot from S10a and is verified in S12b.
   - E12 is charged as intraday.
   - GST excludes STT and stamp duty.
   - Version selection across 2024-10-01.
   - Property: allocations sum exactly.
6. `docs/contributing/fee-rules.md`: how to add a rule version and prove it against a statement.

**Verification:** `pnpm --filter @bhavbook/core test -- --coverage` (100% branches in `fees/`).

**Exit criteria:** the Dhan golden tests are green.

---

## S12b: Reconciliation and FIFO cross-check (strongest)

**Context:** ADR-0017 and PRD §8.2.
- Reported charges replace estimates wherever a statement covers the period.
- Tolerances:
  - Dhan: ±₹0.01 per component per row, with **STT and stamp duty compared per day**.
  - Zerodha: ±₹0.01 per lot and ±₹0.05 per (exit date, instrument).
- Discrepancies still use the reported value.
- PRD §8.2 also requires a **FIFO cross-check**: reported lots vs ours → issue.

**Tasks:** tests first.
1. `core`: `reconcile(fillCharges, statementRows) → {reconciled charges, status per position (FEES_RECONCILED | FEES_DISCREPANCY | FEES_ESTIMATED), per-component diffs}`. Dhan rows are allocated to fills by value.
2. `core`: `crossCheckLots(ourLots, statementLots) → mismatches[]` (by ISIN, dates, qty, value).
3. `server`: persist to `charge_reconciliation`; raise `issue(fee_discrepancy)` and `issue(fifo_mismatch)`.
4. Tests:
   - the Dhan FY 2024-25 fixture → all positions FEES_RECONCILED (with the IPO lot accepted). This includes the deferred S12a check: with the opening lot present, the engine's STT and stamp duty for 18 Sep 2024 equal the Global Transactions day total;
   - an injected ₹1 brokerage diff → FEES_DISCREPANCY with that component's diff;
   - no statement → FEES_ESTIMATED;
   - the cross-check flags the IPO orphan before acceptance and is clean after;
   - **Zerodha Tax P&L tolerance:** a skipped test with a TODO until the FY 2025-26 Tax P&L sample exists (PRD §16).

**Verification:** `pnpm --filter @bhavbook/core test && pnpm --filter @bhavbook/server test`.

**Exit criteria:** green, apart from the documented skips.

---

## S13a: Web shell, onboarding, settings [security review]

**Context:**
- PRD §4. Stack per ADR-0021: React 19.3.1, Vite 8.3.4 + @vitejs/plugin-react 6.1.2, TanStack Router 1.170.45 (+ router-plugin 1.168.47) and Query 5.104.4, Tailwind 4.3.3 (@tailwindcss/vite), shadcn CLI **4.22.1** (`pnpm dlx shadcn@4.22.1 …`; never `@latest`).
- Run `ecc:frontend-design-direction` first and record it in `docs/design/direction.md`.
- Money is shown only via `formatINR`; colour is never the only profit/loss signal (PRD §12).

**Tasks:**
1. Set up `packages/web` (Vite, React, TanStack Router file routes, `shadcn init` with Tailwind 4) and the typed RPC client.
   - **Token handling:** on first load the server sets the cookie, and the app immediately calls `history.replaceState` to strip `?t=` from the URL (ADR-0002 token-leak risk).
2. Onboarding: create or open a vault → profile → broker account (broker plus nickname only; **no client-ID field**).
3. Settings:
   - profiles and accounts (rename; **move an account to another profile → confirm, then recompute**, PRD §2 C5);
   - tags (setup and mistake: CRUD and merge);
   - backups (create, download, restore, list auto-backups);
   - fee rule versions in use (read-only);
   - breakeven threshold (`setting.breakeven_threshold_micro`, default 0).
4. Wire the matching 501 handlers from S11.
5. Tests: component tests; Playwright: onboarding → settings → move account → recompute observed; the URL no longer contains `t=` after load.

**Verification:** `pnpm --filter @bhavbook/web test && pnpm e2e`.

**Exit criteria:** E2E green on 3 OSes; security review clean (token handling, no secrets in the client bundle).

---

## S13b: Import wizard and coverage view

**Context:** PRD §5.1, D11, ADR-0019 (file names are shown in the UI session only and never sent to storage).

**Tasks:**
1. The wizard:
   - drag-drop multiple files → per-file detection (a picker when ambiguous; a rejected kind shows its message);
   - a preview table: new, duplicate, skipped by reason, errors (line plus code only), range, wrong-account warnings, and the **issue forecast**;
   - commit → summary;
   - **import history** with undo.
2. Coverage view: a per-account timeline per report kind, with highlighted gaps and an "import that period" hint linking to the broker download guide (from the NOTES files).
3. Wire the import and coverage handlers.
4. Playwright: import every Zerodha and Dhan fixture → preview counts match the fixture manifest → commit → re-import shows all duplicates → undo.

**Verification:** `pnpm --filter @bhavbook/web test && pnpm e2e`.

**Exit criteria:** E2E green.

---

## S13c: Issues inbox

**Context:** PRD §4. Issue kinds come from:
- S8: `unresolved_instrument`;
- S9: incomplete positions;
- S10a: `fill_from_statement`, `opening_lot_redundant`;
- S10b: corporate-action suspicion;
- S10c: `journal_unattached`, `journal_collision`;
- S12b: `fee_discrepancy`, `fifo_mismatch`;
- S9: inferred-product review (`HAS_INFERRED_PRODUCT`).

**Tasks:**
1. A single inbox with filters by kind and account. Each kind has its action UI:
   - **Fill from broker statement** (accept/dismiss), **Add opening lot** (form), **Exclude**;
   - an instrument-mapping dialog with suggestions;
   - a fee-discrepancy diff table;
   - a product override per (account, instrument, day), including the Zerodha MTF override;
   - journal merge or keep-both.
2. An inbox counter in the navigation. Keyboard navigation.
3. Playwright: resolve one issue of each kind on the fixtures; for each fix, assert the derived state changed as expected.

**Verification:** `pnpm --filter @bhavbook/web test && pnpm e2e`.

**Exit criteria:** E2E green.

---

## S14a: Review queue, position detail, journal, screenshots [security review]

**Context:** PRD §5.3.
- Journal fields: setup tag, thesis, **initial stop** (immutable once the position closes), planned stop and target, optional planned risk in ₹, mistake tags, review note, screenshots.
- Journals can be **drafted on open positions**.
- A review can be **reopened** (REVIEWED → UNREVIEWED).
- Screenshots are converted to `.webp` in the browser (canvas, which strips EXIF), ≤ 1 MB, and stored as BLOBs (ADR-0020).

**Tasks:**
1. Review queue: closed, unreviewed positions, newest first; keyboard next/previous; mark reviewed or reopen; counter in the navigation.
2. Position detail:
   - fills (raw and normalised; declared vs assigned product);
   - lots;
   - a charge breakdown (estimated vs reported, discrepancies, the `mtf_interest_excluded` label);
   - the journal form;
   - paste or drop screenshots.
3. Server: upload endpoint with size enforcement (≤ 1 MB, `image/webp` magic-byte check), then journal CRUD.
4. Tests:
   - a journal entry survives a recompute;
   - over 1 MB is rejected on both client and server;
   - the converted bytes contain no EXIF chunk;
   - reopening works;
   - a draft on an open position persists through close.

**Verification:** `pnpm --filter @bhavbook/web test && pnpm --filter @bhavbook/server test && pnpm e2e`.

**Exit criteria:** E2E green; security review clean (upload path). Manual check, recorded in the PR: reviewing 10 positions with the keyboard only takes under 2 minutes.

---

## S14b: Corporate actions UI and diagnostics export

**Context:** PRD §4 (corporate actions surface) and §3.3 (diagnostics: counts, adapter IDs and row shapes only; raw values only with explicit per-row opt-in).

**Tasks:**
1. Corporate actions page: list, create (type-specific form), the **preview of affected lots** (S10b), save, revert. The suspicion issues from the inbox deep-link here, pre-filled.
2. Diagnostics export (Settings): a JSON with app and schema version, OS, Node version, per-batch counts, adapter IDs and versions, error codes and row *shapes* (column count and types). It **never contains cell values or file names**; a test scans the export for fixture values.
3. Playwright: enter the Tata demerger example → preview → save → positions updated → revert.

**Verification:** `pnpm --filter @bhavbook/web test && pnpm e2e`.

**Exit criteria:** E2E green; diagnostics PII test green.

---

## S15a: core analytics

**Context:** PRD §9 and ADR-0025.
- A **trade** is a CLOSED, non-excluded, complete position (incomplete ones are included only via a toggle).
- **Realisation views** (calendar, equity curve, monthly) use lot exits by IST date.
- **R** = net ÷ planned risk, where planned risk is the user's ₹ amount, else Σ over entries of |fill price − initial stop| × qty. Moving the stop later never changes R.
- **Breakeven:** |net| ≤ `setting.breakeven_threshold_micro`; excluded from the win-rate denominator.
- Net uses reconciled charges where available (S12b), otherwise estimates.

**Tasks** (`packages/core/src/analytics`, pure). Tests first.
1. Metrics: gross, net, win rate, expectancy, average winner and loser, profit factor ("no losses" case), R and average R, holding days, cost of mistakes (a trade with 2 mistakes counts in both).
2. Slices: setup, mistake, profile, account, broker, bucket, month. Every result carries `excluded: {incomplete, excluded, noStop}` counts.
3. Hand-computed fixture tests for every metric and edge case: no trades, no losses, all breakeven, missing stops, partial exits across months.
4. Golden test: **Dhan FY 2024-25 gross realised P&L equals Dhan's P&L report total**, using the test-only reader from S6.

**Verification:** `pnpm --filter @bhavbook/core test -- --coverage`.

**Exit criteria:** green.

---

## S15b: Dashboard (EvilCharts)

**Context:** ADR-0022.
- Charts are **EvilCharts ECharts components** added with `pnpm dlx shadcn@4.22.1 add @evilcharts/echarts-<chart>` (area, line, bar, composed, pie). They're copied into `packages/web/src/components/charts` and use echarts 6.1.0 and motion 14.3.1.
- The **calendar heatmap** is built on EvilCharts' `echarts-chart` base with ECharts' native `calendar` + `heatmap`.
- Record the pull date and commit in `packages/web/src/components/charts/SOURCE.md`. Use the `dataviz` skill for chart choices.

**Tasks:**
1. Dashboard:
   - KPI cards with an "N excluded" note;
   - equity curve (area);
   - monthly P&L (bar);
   - per-setup and per-mistake tables (expectancy, R, count);
   - calendar heatmap of daily realised net;
   - filters (profile, account, broker, bucket, date range, include-incomplete) persisted in the URL.
2. Wire the analytics handlers. Performance: dashboard API responses under 300 ms on a 20k-row synthetic vault (benchmark test).
3. Accessibility: charts have text alternatives (summary tables); profit and loss are not shown by colour alone.

**Verification:** `pnpm --filter @bhavbook/web test && pnpm e2e`.

**Exit criteria:** E2E: the dashboard numbers for the fixture vault equal S15a's golden values.

---

## S16: Packaging, E2E, sanitizer, launch [security review]

**Context:**
- Distribution via `npx bhavbook` (ADR-0001). The CLI and server are bundled with tsdown 0.23.1; the web build ships as static assets inside the package; better-sqlite3 is a runtime dependency (prebuilds).
- Going public requires a sanitizer PASS and **user confirmation** (invariant 10).

**Tasks:**
1. The `bhavbook` package: `bin`, `files`, `engines >=24.11`, and a publish workflow with `npm publish --provenance` on tag. **Ask the user before the first publish.**
2. Cross-OS CI job: `pnpm pack` → install into a temp directory → `npx bhavbook doctor` passes on 3 OSes.
3. Full E2E: a fresh vault → import all fixtures → resolve issues → journal 3 trades → dashboard → backup → restore into a new vault → identical dashboard numbers.
4. Docs:
   - README quick start (from `npx` to the first insight in under 10 minutes);
   - broker download guides (from the NOTES files);
   - privacy statement;
   - adapter contributor guide (template adapter; Groww and Upstox v1.1 as good first issues).
5. Run `ecc:opensource-sanitizer` on the whole repo → PASS. Run `ecc:security-reviewer` on the full diff since S1.
6. **Ask the user** before making the repo public and tagging `v1.0.0`.

**Verification:** CI green on 3 OSes, including pack/install; sanitizer PASS.

**Exit criteria:** PRD §1 success signal on the fixture vault: the **Dhan** FY 2024-25 gross realised P&L matches Dhan's own P&L report (Zerodha has no matching-FY P&L file yet; tracked as a post-launch check).

---

## Plan mutation protocol

- **Split:** a PR over ~800 changed lines (fixtures excluded) is split into `<id>-1/-2` here before continuing; update the table and waves.
- **Insert:** use the next free id with "inserted after <id> because …".
- **Skip or abandon:** mark it `~~<id>~~ skipped: <reason>` and fix the dependents' context.
- **Scope valve** (PRD §15): if behind schedule, move S10b's CONVERSION/DEMERGER and the Zerodha external tradebook (S5b) to v1.1 first. Never cut a broker.
- Log every mutation below.

## Changelog

- 2026-10-19 r5: S5b, S6 and S11 merged (wave 4). S7 split into S7-1 (schema 0002, preview, commit) and S7-2 (undo, coverage) under the ~800-line rule.
  - Undo can't re-parse `raw_row`s as r4 planned: statement rows from spreadsheets have no raw text, a Dhan key's occurrence index depends on the whole file, and Journal CSVs can't be rebuilt without their (never stored) metadata block. Schema 0002 adds `batch_row`: each batch's own canonical copy of every row it contained, deduplicated or not. Undo re-inserts shared keys from the earliest surviving batch's copy, so the final state equals importing the remaining batches in order.
  - From S11 on, steps also get the `ecc:code-reviewer` pass the convention requires; PR titles use `<step-id>: <title>`.

- 2026-10-19 r1: created from PRD Draft 1 + ADR-0001…0026.
- 2026-10-19 r4: S3 and S2 merged; S4 in progress.
  - Lessons from S2's three sanitizer rounds: personal data hides in hyperlink targets/tooltips, comments and their authors, document and custom properties (LastAuthor held a real name), and free-text narrations (a CDSL BOID). Raw container streams must be scanned at both UTF-16 alignments, after dropping unpaired surrogates (they crashed V8's regex engine). Names can't be pattern-matched, so `fixtures:make` fails closed without a local denylist.
  - S4: the vault lives in `packages/server/src/vault`; migrations are SQL files in `packages/server/migrations/` (S16's bundler must ship them); `pii:scan` also covers `packages/server/fixtures` (`.bhav` scanned byte by byte). S7 gained the undo/overlap rule above.
  - Commits use the GitHub no-reply address; history on `main` was rewritten once to remove a personal email.
- 2026-10-19 r3: S1 executed. Invariant 1 now uses `pnpm verify`; repo scripts live in `scripts/`; pnpm 12 needs `allowBuilds` (esbuild) and a dated `minimumReleaseAgeExclude` (eslint 10.13.0).
- 2026-10-19 r2: adversarial review (REWORK) applied.
  - Fixed the dependency graph (S7←S6, S9←S8, S12←S8/S10, S13←S12).
  - Moved all I/O into `packages/server` (core purity).
  - Rejected-kind handling, plus test-only golden readers for AGTS and Dhan P&L.
  - Added missing capabilities: corporate actions UI, settings incl. account move → recompute, FIFO cross-check, order grouping, diagnostics export, MTF label and override, issue forecast, review reopen, open-position journals.
  - Listed every column in 0001 and added a schema-change invariant.
  - Security reviews on S4, S5a, S7, S13a, S14a; logger policy; token stripping.
  - TDD invariant.
  - Split S5, S10, S12, S13, S14, S15.
  - Smaller fixes: version pins (shadcn 4.22.1, `.nvmrc`), exact rates only, a Zerodha Tax P&L skipped test, a precise fidelity rule for XLS, named heuristics, benchmarks.
