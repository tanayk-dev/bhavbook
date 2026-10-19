# BhavBook v1.0 — PRD and Capability Contract

- **Status:** Draft 1, for review. Nothing in here is built yet.
- **Date:** 2026-10-19
- **Sources:** [`PRODUCT-BRIEF.md`](PRODUCT-BRIEF.md) (scope and decisions D1–D11), the [broker export analysis](../broker-exports/README.md) (real Zerodha and Dhan files), and [`.claude/rules/bhavbook/domain.md`](../../.claude/rules/bhavbook/domain.md) (domain rules). The original [reference spec](reference/bhavbook_prd_architecture_specification.md) is a background library only.
- **How to read this:**
  - Every rule is tagged **[POLICY]** (a fixed product promise), **[ARCH]** (an architecture preference that may change with an ADR), or **[OPEN]** (undecided). As of 2026-10-19, every former open question is decided; see §13.
  - §2 lists where this PRD **conflicts with the current domain rules**. Those conflicts need decisions first.

---

## 1. Capability

**Who:** an Indian swing or positional equity trader with accounts at Zerodha and/or Dhan who wants to get better at trading.

**What exists after v1 ships:**
- They run `npx bhavbook`, create a local vault, and drop in the tradebooks they downloaded, in any number and in any order.
- BhavBook rebuilds every **position** from the raw fills. It costs each one (estimated by our fee engine, or reconciled against the broker's own statement) and says plainly where the history is incomplete.
- The trader can then journal each closed position (setup, thesis, stop and target, mistakes, review note, screenshots) and review performance by setup, by mistake, by account and by month.

**What changes:** the trader's weekly review moves from a hand-built Excel sheet to one trustworthy, private record. They can see which setups make money after costs, and what their mistakes cost.

**Success signal:**
- Realised **gross** P&L per account matches the broker's own report exactly (to the paisa) for every period the import fully covers.
- The author completes 8 straight weekly reviews in BhavBook (brief §8).

---

## 2. Conflicts with current repo rules (decided 2026-10-19: amendments approved, Q1)

The real export files contradict four rules in `domain.md`, and the brief adds a fifth point that needs clarifying. The amendments below are **approved**. They become ADRs in the `architecture-decision-records` pass, and `domain.md` is updated at the same time.

| # | Current rule | What the data shows | Amendment (approved) |
| :--- | :--- | :--- | :--- |
| C1 | "Deduplicate on `(broker_account_id, external_trade_id)`" | Dhan rows have **no trade ID or order ID** | The dedup key is **chosen per adapter**. Zerodha uses `zerodha:{exchange}:{trade_date}:{order_id}:{trade_id}`. Dhan uses a content hash plus an occurrence index (§6.3). The constraint becomes `UNIQUE(broker_account_id, dedup_key)` |
| C2 | "Never round in ingestion"; "parse the decimal string directly" | Zerodha prices are float32 artefacts (`700.599976` for ₹700.60). Taking the string literally stores the **wrong** price. Rounding to paise reproduces the broker's annual totals exactly for all 32 symbol/exchange rows | Allow **declared, per-adapter normalisation** to the broker's known precision during ingestion, done as a decimal-string operation (never through a float). The raw string is always kept next to the normalised value. The "never round" rule still applies to the fee engine and to storage of computed values |
| C3 | `price_micro` is the trade's money truth | Dhan's `Trade Price` is a rounded average. In 16 of 116 rows, `qty × price ≠ Trade Value` | Store `trade_value_micro` on every fill, with `value_authority ∈ {price, value}`. For Dhan, the value is authoritative and the price is derived from it |
| C4 | "Partial fills group into logical trades" | Zerodha rows are exchange fills. Dhan rows are already orders or aggregates | The canonical row is a **fill-or-order** (`granularity ∈ {fill, order}`). Grouping into orders only happens where `granularity = fill` |
| C5 | FIFO is scoped by profile (domain.md) and by account (brief §6) | — | Both hold. **An account belongs to exactly one profile**, so FIFO per account per bucket never crosses profiles. Moving an account to another profile triggers a recompute **[POLICY]** |

---

## 3. Constraints

### 3.1 Scope boundaries **[POLICY]**

- **Brokers:** Zerodha and Dhan only. The adapter contract has to let Groww and Upstox drop in for v1.1 without schema changes.
- **Segments:** NSE/BSE equity cash only.
  - F&O, currency, commodity and mutual fund (Zerodha Coin) rows are **detected, skipped and counted** in the import summary. They are never silently dropped.
- **Product buckets:**
  - `DELIVERY`, `INTRADAY` and `MTF` are in.
  - MTF is a separate FIFO bucket. Its **interest is not modelled** (no ledger import in v1).
- **Input:** CSV, XLSX and legacy `.xls` files that the user downloads. Out of scope for v1:
  - broker APIs, OAuth or stored credentials;
  - contract-note PDFs;
  - anything that is email-only from the broker.
- **Market data:** none in v1, so there are no unrealised P&L marks. Open positions are shown at cost.

### 3.2 Invariants (must always hold, and must be covered by tests)

1. **Money:** every monetary value is a micro-rupee integer. Arithmetic is `bigint`, and SQLite uses `safeIntegers`. No float ever touches money. **[POLICY]**
2. **Raw is immutable:**
   - An imported row is stored exactly as the broker sent it: the raw row text, plus a file hash and line number.
   - Normalised fields sit alongside the raw text and never replace it.
   - Nothing in the UI edits imported rows. **[POLICY]**
3. **Derived state is rebuildable:**
   - Orders, positions, FIFO lots, charge estimates and analytics are a **pure function** of three inputs: (imported rows + manual adjustments + corporate actions + fee rule files).
   - Recomputing from scratch gives byte-identical results. **[ARCH]**
4. **Idempotent import:** re-importing any file, or any overlapping set of files, adds 0 rows the second time. **[POLICY]**
5. **No negative holdings:** if a sell would take quantity below zero, the gap is never filled with an invented buy.
   - The position is marked **INCOMPLETE** instead (§5.2).
   - Only the user can supply the missing entry, with an opening lot. **[POLICY]**
6. **Isolation:** FIFO is keyed on `(account, instrument, product_bucket)`. It never crosses accounts, profiles or buckets.
   - **Exchange is not part of the key**: real data has buys on NSE closed by sells on BSE. **[POLICY]**
7. **Time:**
   - `executed_at` is stored in UTC.
   - Trade date, same-day detection, holding period and month buckets are all computed in `Asia/Kolkata` and never in the machine's timezone.
   - Broker timestamps arrive without a timezone and are interpreted as IST. **[POLICY]**
8. **Determinism of fees:** the fee rule version is chosen by **trade date**, never "latest". **[POLICY]**
9. **Broker numbers win:** where a broker statement covers a period, the reported charges replace the estimates for that period's positions. The estimate stays visible next to them. **[POLICY]** (D5)
10. **Privacy:**
    - These values are never stored, logged or shown in error reports: PAN, client ID/UCC, name, mobile or email from file metadata blocks.
    - No outbound network calls of any kind.
    - The server binds to `127.0.0.1` only. **[POLICY]**

### 3.3 Trust boundaries

| Boundary | Threat | Requirement |
| :--- | :--- | :--- |
| Uploaded files → parser | Malformed or hostile CSV/XLSX/XLS (zip bombs, huge files, formula cells) | Size limit 25 MB and 200k rows per file (Q12); parse with formulas disabled (cached values only); time and row limits; a parse error never crashes the server |
| Browser → local server | Any website the user visits can send requests to `localhost`; DNS rebinding | The launch URL carries a random **session token** (stored in an HttpOnly cookie after the first load). Every request needs the token; the `Host` and `Origin` headers are checked against an allowlist; no CORS. **[POLICY]** |
| Screenshots | EXIF and location metadata | Re-encode to `.webp`, which strips the metadata; set a size limit |
| Error reports and diagnostics | Personal data leaking into a bug report | Diagnostics export contains counts, adapter IDs and row shapes, never raw cell values, unless the user explicitly opts in per row |

---

## 4. Actors and surfaces

**Actors:**
- **Trader:** the only user. Single-user, local, no login.
- **Contributor:** writes broker adapters against the adapter contract and fixtures.
- **Maintainer:** updates fee rule files when rates change.

**Surfaces (v1):**

| Surface | Purpose |
| :--- | :--- |
| CLI `npx bhavbook [--vault <path>] [--port <n>]` | Start the server and open the browser with the token URL. Commands: `backup`, `restore <file>`, `doctor` |
| **Onboarding** | Create or open a vault → create a profile → add a broker account (broker plus a nickname; we **never ask for a client ID**) → import |
| **Import wizard** | Drop files → auto-detect broker and report type → preview → commit. Uses the multi-file flow from D11 |
| **Coverage view** | Per-account timeline of the ranges imported, with gaps highlighted |
| **Issues inbox** | One list of everything that needs the user: incomplete positions, unresolved instruments, fee discrepancies, inferred product types, corporate-action suspicions |
| **Review queue** | Closed positions not yet reviewed, newest first. This drives the weekly ritual |
| **Position detail** | Fills, lots, charges (estimated vs reported), journal, screenshots |
| **Dashboard and analytics** | The metrics in §9, with slices and filters |
| **Corporate actions** | Enter split, bonus, conversion or demerger; see the positions affected |
| **Settings** | Profiles and accounts, tags, backups, fee rule versions in use |

---

## 5. States and transitions

### 5.1 Import batch

```
uploaded → detected → parsed → previewed → committed
                 ↘ unrecognised     ↘ failed     ↘ discarded
```

- **detected:** the adapter claims the file with a report kind (e.g. `zerodha.tradebook`, `dhan.trade_history`, `dhan.global_transactions`). If more than one adapter claims the file, the user picks.
- **previewed:** the counts are shown before anything is written:
  - new rows;
  - duplicates;
  - out-of-scope rows skipped (by reason);
  - row errors;
  - the date range covered;
  - the issues the commit would create or resolve.
- **committed:** one SQLite transaction inserts the rows and then triggers a recompute. A partial commit is impossible.
- A committed batch can be **rolled back** (undo import). This deletes its rows (and only its rows) and recomputes. **[POLICY]**

**Row outcomes:** `accepted | duplicate | skipped(out_of_scope: fno|currency|commodity|mf|other) | error(reason)`.

### 5.2 Position (derived)

```
OPEN ──(qty returns to 0)──→ CLOSED
  └ flags (independent of state): INCOMPLETE, EXCLUDED, HAS_INFERRED_PRODUCT, FEES_ESTIMATED | FEES_RECONCILED | FEES_DISCREPANCY
```

- **A position** is one run of `(account, instrument, bucket)` from quantity 0 → non-zero → 0. Scale-ins and scale-outs stay inside one position.
- **INCOMPLETE:**
  - Set when a sell exceeds the quantity held at that moment. The unmatched quantity is called the **orphan quantity**.
  - Cleared when an imported older fill or a manual opening lot covers it.
- **EXCLUDED:** set by the user. It also applies **by default to INCOMPLETE positions** in analytics (D11).
- **Open positions** that have partial exits contribute realised P&L for their closed lots (§9.1). They do not count as a "trade" in win rate or expectancy until the whole position is closed.

### 5.3 Review (journal)

```
CLOSED position: UNREVIEWED → REVIEWED   (user can reopen to UNREVIEWED)
OPEN position: journal may be drafted (thesis, stop, target) at any time
```

### 5.4 Instrument resolution

```
UNRESOLVED(broker, broker_name|symbol) → RESOLVED(isin, source: file|learned|manual)
```

- FIFO still works for an UNRESOLVED instrument, keyed on its broker-local identity, so an unresolved name never blocks an import.
- Cross-account instrument views need RESOLVED.

### 5.5 Manual adjustment

```
active ⇄ reverted ; active → superseded (when an import now covers the gap; offered, never automatic)
```

---

## 6. Interface contract: broker adapters

### 6.1 Adapter interface **[ARCH]**

```ts
interface BrokerAdapter {
  broker: BrokerId;                       // 'zerodha' | 'dhan' | ...
  reportKinds: ReportKind[];              // what this adapter can read
  detect(probe: FileProbe): Detection | null;   // sniff headers/sheet names; no full parse
  parse(file: InputFile, kind: ReportKind): ParseResult;
}

interface ParseResult {
  rows: CanonicalRow[];                   // trade rows (tradebook kinds)
  statements?: StatementRow[];            // charge/lot rows (reconciliation kinds)
  instrumentHints?: InstrumentHint[];     // e.g. name → ISIN learned from a tax report
  skipped: SkippedRow[];                  // out of scope, with reason
  errors: RowError[];                     // line, reason (never the raw PII-bearing cell)
  coverage: { from: IsoDate; to: IsoDate } | null;   // declared range (metadata) or observed range
}
```

- Adapters are **pure**: bytes in, data out. They do no I/O and no DB access, and they never see the vault.
- Every adapter ships fixtures plus golden expected output (§11).

### 6.2 Canonical trade row

| Field | Notes |
| :--- | :--- |
| `dedup_key` | Per-adapter strategy (§6.3) |
| `granularity` | `fill` \| `order` |
| `external_order_id` | Nullable (Dhan: null). Stored as a **string**: Zerodha IDs have 19 digits |
| `executed_at_utc`, `trade_date_ist` | Converted from IST |
| `side` | `BUY` \| `SELL` |
| `quantity` | Integer. A non-integer equity quantity is a row error (Zerodha writes `10.000000`) |
| `price_micro`, `trade_value_micro`, `value_authority` | See C2 and C3 |
| `exchange` | `NSE` \| `BSE` |
| `isin` | Nullable (Dhan: always null; Zerodha: sometimes blank) |
| `broker_symbol`, `broker_name` | Whichever the broker gives |
| `product_declared` | `DELIVERY` \| `INTRADAY` \| `MTF` \| null (Zerodha: null) |
| `flags` | e.g. `auction` (Zerodha `auction=true`) |
| `raw` | The original row text, plus `source_file_sha256` and `line_no` |

### 6.3 v1 report kinds

| Kind | Role | Dedup key | Normalisation |
| :--- | :--- | :--- | :--- |
| `zerodha.tradebook` (CSV; also the "Equity (external trades)" segment → `source=external`) | Trades | `zerodha:{exchange}:{trade_date}:{order_id}:{trade_id}` (Q3) | Price rounded half-up to 0.01 as a decimal string; fills grouped by `order_id`; a blank ISIN filled from the same-symbol ISIN in the file or vault, otherwise UNRESOLVED |
| `dhan.trade_history` (CSV, "All Exchange Transactions") | Trades | `sha256(date, time, name, side, order_type, exchange, qty, value)` + the occurrence index of identical tuples within that file | Value authoritative; the `Order` column maps to `product_declared` (MTF → `MTF`); only `Status = Traded` rows are imported |
| `dhan.global_transactions` (CSV) | Charges reconciliation, per (date, scrip) | `(date, scrip, bill_no)` | Journal CSV layout: skip the metadata block **and do not store it** |
| `dhan.tax_report` (`.xls`) | FIFO cross-check; **ISIN via transaction join** (Q10); **opening-lot suggestions** (§13) | n/a (statement) | Parse by header name; float cells rounded to paise |
| `dhan.dp_charges` (CSV) | DP charges; ISIN via transaction join | `(date, isin, type)` | — |
| `zerodha.tax_pnl` (XLSX) | Charges reconciliation per FIFO lot; **opening-lot suggestions** | `(symbol, isin, entry, exit, qty)` + occurrence index | Allocations to 4 decimals, which can be negative → compare with a tolerance |

The following are **detected and rejected with a helpful message in v1** ("useful later, not needed now"). They are documented in the broker notes and are v1.1 candidates:
- Zerodha AGTS and P&L;
- Dhan P&L, Realised P&L, Ledger and Fund Summary.

The Zerodha external tradebook **is in v1** (Q8). A sample file is still needed for its fixture.

### 6.4 Wrong-account guard (decided, Q9) **[POLICY]**

Some file names and metadata blocks contain the client ID. A file imported into the wrong account would silently mix two people's trades.

- **No client ID is stored, hashed or not.** Zerodha IDs (2 letters + a few digits) can be brute-forced, so a hash is just the ID in disguise.
- **Overlap heuristic:** if a file's date range overlaps the account's covered range but shares less than 10% of its dedup keys there, warn: "This file may be from a different account."
- The preview always shows the range and counts, and an import can be undone.
- **Original file names are not stored** (Zerodha and Dhan put the client ID in them). Only `file_sha256`, report kind and coverage are kept.

---

## 7. Position reconstruction rules

### 7.1 Pipeline (pure, deterministic)

```
canonical rows
  → instrument resolution (ISIN | broker-local id)
  → product bucket assignment (declared, or inferred per §7.2, or user override)
  → apply corporate actions (§7.4) and manual adjustments (opening lots, exclusions)
  → per (account, instrument, bucket): sort by executed_at, then dedup_key (stable)
  → FIFO lot matching → lots (entry fill, exit fill, qty, entry/exit value)
  → positions (0→n→0 runs) with INCOMPLETE where orphan qty > 0
  → charges per fill (engine) → allocation to lots → reconciliation overlay (§8)
```

### 7.2 Zerodha product inference (no product column) **[POLICY with override]**

1. For each `(account, instrument, IST trade date)`: `intraday_qty = min(total bought that day, total sold that day)`.
2. That day's buys and sells are matched in time order up to `intraday_qty`. The matched quantity goes to the **INTRADAY** bucket, and the rest stays **DELIVERY**. A single fill can be **split** across the two buckets (fill allocations).
3. Every inferred allocation is flagged `HAS_INFERRED_PRODUCT`. The user can override a day, which re-buckets that whole `(account, instrument, date)`.
4. **Existing holdings don't change the rule** (Q5): selling held shares and buying the same quantity back on the same day is intraday by quantity, and the held lot is untouched (E3). A BTST (sold the next day) is delivery.
5. Validation:
   - On Dhan's tax report, the same rule reproduced **11/11** intraday lots, including DELIVERY- and MTF-declared orders (research A2).
   - The Zerodha tradebook has 3 same-day round trips, which become fixtures against a matching-FY Tax P&L.

### 7.3 Dhan product mapping

- **The same-day netting rule from §7.2 applies to Dhan as well** (Q5, Q6). The netted quantity goes into INTRADAY for journal, FIFO and fees, whatever the declared product. That's how Dhan itself charges and taxes it.
- For the quantity that isn't netted, the bucket follows `product_declared` (DELIVERY / MTF). An INTRADAY-declared remainder (one converted to delivery) goes to DELIVERY.
- `product_declared` stays visible ("ordered as MTF").

### 7.4 Corporate actions (manual in v1) **[POLICY]**

| Type | Input | Effect on open lots at the ex-date |
| :--- | :--- | :--- |
| `SPLIT` | ISIN, ex-date, ratio (e.g. 1:5) | qty × ratio; total cost unchanged; the original entry date is kept (for holding period) |
| `BONUS` | ISIN, ex-date, ratio (e.g. 1:1) | Adds bonus lots at **cost ₹0, acquisition date = allotment date** (s.55(2)(aa); Q7). The position view shows the blended average (total cost ÷ total quantity) |
| `CONVERSION` | old ISIN → new ISIN, ratio, date | Lots move to the new ISIN; cost and entry dates carried over. Covers ISIN changes and DVR conversion |
| `DEMERGER` | parent ISIN, child ISIN, ratio, cost-split % (from the company's announcement), date | The child lot inherits the parent's entry date and a share of its cost. Example: Tata Motors (Oct 2025) 1:1 → 68.85% TMPV / 31.15% TMCV (verify against the company's filing before shipping it as a preset) |

- **Reason for including CONVERSION and DEMERGER:** the author's own Zerodha data includes the Oct 2025 Tata Motors demerger and a TATAMTRDVR position. Splits and bonuses alone would get the author's own history wrong.
- **Scope pressure valve** (brief §6) still applies: if v1 slips, CONVERSION and DEMERGER move to v1.1 before splits do.
- **Suspicion heuristics** (raised in the issues inbox, never auto-applied):
  - an orphan sell quantity that is an integer multiple of the holding;
  - an ISIN that disappears while still held.

### 7.5 Worked examples (become unit tests)

| # | Scenario | Expected |
| :--- | :--- | :--- |
| E1 | Buy 10 @100, Buy 10 @110, Sell 15 @120, Sell 5 @90 | 1 position; lots (10@100→120), (5@110→120), (5@110→90); gross = 200 + 50 − 100 = ₹150 |
| E2 | Same day: Buy 20 @100, Sell 20 @101 (Zerodha) | INTRADAY bucket, 1 position, gross ₹20, inferred flag |
| E3 | Hold 10 (previous days); same day Buy 5, Sell 5 | 5 intraday (same-day matched), 10 delivery untouched |
| E4 | Buy NSE 10 @100; Sell BSE 10 @105 | One position (same ISIN), gross ₹50 |
| E5 | Sell 10 with no prior buy in the vault | Position INCOMPLETE, orphan qty 10, excluded from analytics by default |
| E6 | E5, then the user adds an opening lot 10 @80 "before 2025-09-12" | Complete; gross = proceeds − ₹800; adjustment shown as `source=manual` |
| E7 | E6, then an older tradebook import containing the real buy | The import is accepted; the opening lot is now redundant, so the user is offered "replace the manual lot" (positions use the real fill once accepted) |
| E8 | Hold 10 @500; SPLIT 1:5; sell 50 @110 | Lot becomes 50 @100, gross ₹500, entry date unchanged |
| E9 | Dhan row `11 × 891.97`, value 9811.70 | `trade_value_micro = 9_811_700_000`; P&L uses the value, not qty × price |
| E10 | Zerodha price `700.599976` | Stored `price_micro = 700_600_000`, raw string kept |
| E11 | Dhan 18 Sep 2024 (real): Buy 100 @181 (09:07), Sell 100 @173.50 (09:16:37), Sell 200 @174.05 (09:16:45); 200 IPO shares not in the trade file | 100 intraday (buy vs the *earliest* sell), gross −₹750. The 200 sell is an orphan → INCOMPLETE. The Tax Report lot 200 @ ₹176 (17-09-2024) is offered as an opening lot (`source=broker_statement`); once accepted, delivery gross is −₹390 |
| E12 | Dhan MTF Buy 2 @933.90, Sell 2 @953.30, same day (real) | INTRADAY bucket (declared MTF shown); charged as intraday (brokerage 0.03%, STT 0.025% on the sell) |

---

## 8. Fee engine and reconciliation

### 8.1 Engine scope (v1) **[POLICY]**

- **Segments:** equity delivery, equity intraday, and MTF. MTF is charged like delivery (STT 0.1% both sides, stamp duty 0.015%) plus the broker's MTF brokerage: Zerodha 0.3% or ₹20, Dhan 0.03% or ₹20, per order. **Interest is not modelled**, and MTF positions are labelled "excludes MTF interest" (Q4).
  - Zerodha MTF fills are indistinguishable from delivery in the tradebook. Their brokerage is underestimated until reconciliation; the user can override per position.
- **Components:** brokerage (broker plan), STT, exchange transaction charges (NSE/BSE), SEBI fee, IPFT, stamp duty, GST (on brokerage + exchange txn + SEBI + IPFT only), and DP charges.
  - DP charges apply **per scrip per sell day** for delivery: Dhan shows ₹12.50 plus GST; Zerodha shows ₹15.34 or ₹15.93.
- **Rule files** are JSON, versioned by effective date, per broker plan (brokerage) and per exchange (statutory). Rates are decimal strings.
  - Every rule version must pass golden tests against the broker statements we hold for its period (Q13). Known change point: NSE txn 0.00322% → 0.00297% on 2024-10-01.
- **Computation level (decided, Q4; verified on Dhan data):**

  | Component | Unit computed on | Rounding |
  | :--- | :--- | :--- |
  | Brokerage | Each executed order | Paise |
  | STT | Contract note = (account, IST date, exchange), per charge class | **Rupee, half-up** |
  | Stamp duty | Contract note, buy side, per charge class | **Rupee, half-up** |
  | Exchange txn, SEBI, IPFT | Contract note turnover | Paise |
  | GST | 18% × (brokerage + txn + SEBI + IPFT) | Paise |
  | DP | (ISIN, delivery sell day) | Fixed ₹ per rule version |

  Contract-note totals are **allocated to fills pro rata by value** using largest remainder, so the parts always sum exactly. **[ARCH]**

### 8.2 Reconciliation **[POLICY]**

| Source | Granularity | Match on | Tolerance | When matched |
| :--- | :--- | :--- | :--- | :--- |
| `dhan.global_transactions` | (date, scrip), per component, paise | trade date + resolved instrument | ±₹0.01 per component per row; **STT and stamp duty compared at day level** (exact rupee total), because the per-scrip split drifts by paise | Reported charges replace the estimates for those fills (allocated by value) → `FEES_RECONCILED` |
| `zerodha.tax_pnl` | FIFO lot, per component, 4 decimals | instrument + entry/exit dates + qty | ±₹0.01 per component per lot; sums per (exit date, instrument) within ±₹0.05; re-derive both from a matching-FY file | Same → `FEES_RECONCILED` |

- Outside tolerance, the position gets `FEES_DISCREPANCY` with a per-component diff in the issues inbox. **The reported value is still used** (D5); the estimate is shown next to it.
- **No statement for the period:** `FEES_ESTIMATED`, and the UI labels every net figure "estimated".
- **FIFO cross-check (free, from the same files):** reported lots (Dhan tax report, Zerodha tax P&L) are compared against our lots. A mismatch raises an issue. This is how incomplete history and missing corporate actions show up early.

---

## 9. Analytics definitions

### 9.1 Units

- **Trade = a CLOSED position** that is not EXCLUDED and not INCOMPLETE (unless the user includes incomplete positions). This unit drives win rate, expectancy, profit factor, R and holding period.
- **Realisation event = a closed lot**, dated by its exit fill's IST date. This drives the calendar heatmap, equity curve and monthly P&L, so partial exits count in the month they happened.

### 9.2 Metrics **[POLICY unless marked]**

| Metric | Definition | Edge cases |
| :--- | :--- | :--- |
| Gross P&L | Σ(exit value − entry value) over lots | — |
| Net P&L | Gross − all charges (reported where reconciled, otherwise estimated) | Shown "estimated" if any charge on it is estimated |
| Win / loss | Net P&L > 0 / < 0 | Breakeven = \|net\| ≤ threshold (setting, default ₹0): counted as a trade but left out of the win rate's numerator and denominator (Q11) |
| Win rate | wins / (wins + losses) | No trades → "—" |
| Expectancy (₹) | mean net P&L per trade | — |
| Avg winner / avg loser | mean net of wins / of losses | — |
| Profit factor | Σ net wins / \|Σ net losses\| | No losses → "∞" (shown as "no losses") |
| R-multiple | net P&L ÷ planned risk. Planned risk = the ₹ amount the user enters, else Σ over entry fills of \|fill price − **initial** stop\| × qty (Q11) | Moving the stop later never changes R. No stop and no risk amount → R undefined, excluded from R averages, and counted ("12 trades without a stop") |
| Avg R | mean R over trades with R defined | — |
| Holding period (trade) | IST calendar days from first entry fill to final exit fill | Intraday = 0 days |
| Holding class (lot, informational) | Short term ≤ 12 months, long term > 12 months, per lot, from the lot's entry date (corporate-action rules in §7.4 apply) | Labelled "informational, not tax advice" |
| Cost of mistakes | Σ net P&L of trades tagged with each mistake | A trade with 2 mistake tags counts in both (stated in the UI) |

**Slices:** setup tag, mistake tag, profile, account, broker, bucket, and month (by exit date for trades; by lot exit for realisation views). All filters combine.

---

## 10. Data model (v1) **[ARCH]**

SQLite `STRICT` tables. Money columns are `*_micro INTEGER`; IDs are `TEXT` (ULID).

| Entity | Key fields | Notes |
| :--- | :--- | :--- |
| `pan_entity` | id, label | A single hidden default in v1 (keeps the 3-tier hierarchy). **No PAN is stored in v1** |
| `profile` | id, pan_entity_id, name | — |
| `broker_account` | id, profile_id, broker, nickname | **No client ID in any form** (§6.4) |
| `import_batch` | id, account_id, file_sha256, report_kind, adapter_version, coverage_from/to, counts, status, created_at | Undo = delete batch → cascade to its rows |
| `raw_row` | id, batch_id, line_no, raw_text | Never includes the metadata header block |
| `trade_row` | id, account_id, batch_id, raw_row_id, dedup_key, the canonical fields of §6.2 | `UNIQUE(account_id, dedup_key)` |
| `instrument` | id, isin?, display_name | — |
| `instrument_alias` | broker, alias (symbol/name), instrument_id, source, valid_from? | Name → ISIN mappings, learned or manual |
| `statement_row` | id, batch_id, kind, key fields, per-component `*_micro` | Reconciliation inputs |
| `corporate_action` | id, type, isin(s), ex_date, ratio (num/den), cost_split_bp? | Entered by the user |
| `adjustment` | id, account_id, type (`opening_lot` \| `exclude` \| `product_override`), payload, source (`manual` \| `broker_statement`), status, created_at | Can be reverted |
| `journal_entry` | id, anchor (account_id, instrument_id, bucket, opening_dedup_key), setup_tag, thesis, planned_stop/target_micro, review_note, reviewed_at | See §10.1 |
| `tag`, `journal_tag` | kind ∈ {setup, mistake} | — |
| `attachment` | id, journal_entry_id, webp BLOB, created_at | Stored **in SQLite** so backups are atomic; converted in the browser, max 1 MB each **[ARCH]** |
| *derived:* `position`, `lot`, `fill_charge`, `issue` | — | Rebuilt by the recompute; can be cached tables or views |

### 10.1 Journal anchoring (a hidden constraint) **[POLICY]**

- Positions are derived and can change shape when older history arrives (E5 → E7). Journal entries therefore attach to a stable **anchor**, not to a position ID. The anchor is the dedup key of the position's opening entry: a fill, or a manual opening lot.
- After a recompute, the journal follows whichever position now contains its anchor fill.
- If two journal entries end up on one position, both are kept and an issue is raised: "merge or keep both".
- A journal entry is **never deleted** by a recompute.

### 10.2 Backup and migrations **[POLICY]**

- **Backup format:** `.bhav` is a `VACUUM INTO` snapshot plus a manifest (`schema_version`, `app_version`, `sha256`). Screenshots are inside the DB, so a backup is a single file.
- **Auto-backup** runs before every migration and before every import commit, and the last 10 are kept, plus every pre-migration backup (Q12).
- **Restore** checks the SHA-256 first, restores into a temporary path, migrates forward, and only then swaps it in.
- **Migrations** are numbered and forward-only. Each one is tested by restoring a fixture backup from the previous schema.

---

## 11. Test strategy

- **Coverage:** ≥ 80% overall, and 100% branch coverage of money, FIFO and fee code **[ARCH]**.
- **Test layers:**

| Layer | What | Golden source |
| :--- | :--- | :--- |
| Money/time utils | Decimal string → micro, rounding, IST/UTC, bigint overflow cases | Hand-written cases |
| Adapters | Every v1 report kind parses the scrubbed real files in `fixtures/`; detect() picks the correct kind; Journal CSV footer with no trailing newline; `.xls` BIFF | The real files (§12) |
| Dedup | Re-import, overlapping ranges, identical Dhan rows | Constructed from the fixtures |
| FIFO end-to-end, Dhan | **The Dhan trade file covers the full account history** (first trade 2024-04-22), so trades → our FY 2024-25 lots must equal the Dhan Tax Report's tradewise table | Dhan Tax Report `.xls` |
| Charges, Dhan | Engine estimate vs Global Transactions per (date, scrip, component) | Dhan Global Transactions |
| Totals, Zerodha | Tradebook FY 2025-26 buy/sell totals per symbol/exchange = AGTS | Zerodha AGTS (already shown to match exactly) |
| FIFO/charges, Zerodha | Needs the FY 2025-26 Tax P&L (**not yet provided**) | — |
| Reconstruction | Worked examples E1–E10, plus property tests: invariants 4, 5 and 6 hold for random fill sequences | — |
| Incomplete history | The real Zerodha file (10 orphan sells on 2025-09-12) shows exactly 10 INCOMPLETE positions | The real file |
| Security | Token required, Host/Origin rejection, `127.0.0.1` binding, file limits, no outbound sockets (test fails if any socket opens) | — |
| E2E | Onboarding → import both brokers → review a trade → dashboard → backup/restore | Playwright |

**Fixture rule:** fixtures in the repo are scrubbed copies, checked by `ecc:opensource-sanitizer` before the first public push. The `docs/broker-exports/` originals stay out of git.

---

## 12. Non-functional requirements

| Area | Requirement |
| :--- | :--- |
| Privacy | No telemetry, no update checks, no outbound requests. This is verified by a test (§11) **[POLICY]** |
| Network | Bind to `127.0.0.1`; random free port by default; token plus Host/Origin checks **[POLICY]** |
| Performance (proposed targets) | Import 5,000 rows in < 5 s; full recompute of 20,000 rows in < 3 s; dashboard query in < 300 ms on a mid-range laptop (Q12) |
| Platforms | Windows, macOS and Linux; Node LTS. Native module (`better-sqlite3`) prebuilds must exist for all three **[ARCH]** |
| Reliability | Every import commit is one transaction; crash-safe (WAL); auto-backup before risky operations |
| Accessibility | Keyboard-navigable review queue and forms; colour is never the only signal for profit or loss |
| Formatting | Indian digit grouping (₹1,23,456.78); dates `dd MMM yyyy`; IST shown everywhere; one shared money formatter |

### 12.1 Technology stack (decided, Q2) **[ARCH]**

The ADRs in [`../adr/`](../adr/README.md) are authoritative. Exact versions (latest stable as of 2026-10-19) are pinned in [ADR-0021](../adr/0021-tech-stack-and-versions.md).

| Layer | Choice | Rejected and why |
| :--- | :--- | :--- |
| Language and repo | TypeScript **6.0.3** (strict; 7.x waits for typescript-eslint support), pnpm workspaces: `core` (money, time, fees, FIFO; pure), `adapters`, `server`, `web`, `cli` | — |
| Runtime | Node **24 LTS** (`engines >=24.11`) | Node 26: not yet LTS |
| DB | `better-sqlite3` with `safeIntegers`, WAL, `STRICT` tables; raw SQL migrations | `node:sqlite`: experimental on LTS, no transaction helper; revisit at Node 26 LTS |
| Data access | Hand-written repositories over typed SQL (`kysely` allowed as a query builder) | Heavy ORMs hide `bigint` handling |
| Server | Hono + `@hono/node-server`, typed RPC client for the UI | Express (untyped); Fastify is fine, but Hono's typed client is less glue code |
| UI | React 19 + Vite 8 SPA, served by the server; TanStack Router and Query; Tailwind 4 + shadcn/ui | SSR frameworks are unnecessary for a local single-user app |
| Charts | **[EvilCharts](https://github.com/legions-developer/evilcharts)** ECharts components (shadcn registry, copied in as owned code) on `echarts` 6; calendar heatmap built on EvilCharts' `echarts-chart` base (ADR-0022) | EvilCharts' Recharts variants: no calendar heatmap, and it would mean a second engine |
| Spreadsheets | SheetJS CE **0.20.3** from `cdn.sheetjs.com`, pinned by integrity hash, run in a `worker_thread` with time and size limits, formulas ignored | npm `xlsx@0.18.5` (unpatched CVEs); `exceljs` and `read-excel-file` can't read `.xls` BIFF |
| CSV | `csv-parse` (sync), after the adapter strips the metadata and footer blocks | — |
| Money and rates | Own decimal-string → `bigint` micro parser; rates as bigint rationals with explicit rounding modes; ESLint ban on `parseFloat`, `Number()` and `toFixed` in `core` and `adapters` | `decimal.js`: not needed once rates are rationals |
| Validation | `zod` at the HTTP and adapter boundaries | — |
| Images | Converted to `.webp` **in the browser** (canvas), which strips EXIF; stored as BLOBs | `sharp`: an extra native dependency |
| Tests | Vitest, `fast-check` (property tests), Playwright | — |

---

## 13. Decisions on the former open questions (2026-10-19)

All 13 are **decided**. The evidence and sources are in [`research/2026-10-19-open-questions.md`](research/2026-10-19-open-questions.md), where "A" items are tests on our own exports.

| # | Question | Decision | Why (evidence) |
| :--- | :--- | :--- | :--- |
| Q1 | C1–C4 rule amendments | **Approved as proposed in §2.** They go into ADRs, then `domain.md` is updated | Every one of them is forced by the real files |
| Q2 | Tech stack | See **§12.1**: TypeScript in a pnpm monorepo; Node LTS; `better-sqlite3`; Hono; React + Vite; ECharts; SheetJS CE 0.20.x from the official CDN; `csv-parse`; **no decimal library** (bigint micro + bigint rational rates) | `node:sqlite` is still experimental on LTS; npm `xlsx@0.18.5` has unpatched CVEs; ECharts ships a calendar heatmap |
| Q3 | Zerodha dedup key | `zerodha:{exchange}:{trade_date}:{order_id}:{trade_id}` | No official statement that `trade_id` is unique; 5-digit IDs suggest sequences that reset (A6). Every part is stable across re-downloads |
| Q4 | Fee granularity and MTF | **Contract note = (account, IST trade date, exchange).** <br>• STT and stamp duty: computed on the contract note's turnover by class (delivery/intraday), **rounded half-up to the rupee**, then allocated to fills by value (largest remainder). <br>• Brokerage: **per executed order**. <br>• Exchange txn, SEBI and IPFT: per contract note, rounded to paise. <br>• GST: 18% of (brokerage + txn + SEBI + IPFT). <br>• DP: per (ISIN, delivery sell day). <br>• **MTF** is charged like delivery plus the broker's MTF brokerage (Zerodha 0.3%/₹20; Dhan 0.03%/₹20); **interest is not modelled**, and positions say so | 45/46 days STT and 46/46 days stamp duty match on Dhan data (A1); official pages |
| Q5 | Same-day with existing holdings | **Same-day netting rule for both brokers:** for (account, ISIN, IST date), `intraday_qty = min(bought, sold)`, matched **in time order**, and the rest stays in its bucket. This applies whatever the declared product | 11/11 Dhan intraday lots reproduced, including DELIVERY- and MTF-declared orders; earliest sell matched first (A2) |
| Q6 | Dhan MTF same-day: bucket vs fee class | **No split.** The same-day netted quantity goes into the **INTRADAY** bucket for journal, FIFO *and* fees. The declared product is kept as a field and shown ("ordered as MTF") | That's how the broker itself taxes and charges it (A2); one rule is simpler than two |
| Q7 | Bonus cost | **Tax-faithful lots:** bonus lots cost ₹0 with acquisition date = allotment date. The position view shows the blended average (total cost ÷ total quantity), so both views come from the same lots | Section 55(2)(aa) |
| Q8 | Zerodha external tradebook | **In v1.** It's the same Tradebook page with the segment set to "Equity (external trades)", parsed by the same adapter with `source=external`. Sample file needed | Covers IPOs, OFS and corporate actions (Zerodha support) |
| Q9 | Wrong-account guard | **No client-ID hash.** Zerodha IDs (2 letters + digits) are brute-forceable, so a hash is the ID in disguise. Instead: (a) a **heuristic warning**: the file overlaps the account's covered range but shares less than 10% of the dedup keys; (b) the import preview always shows the date range and counts; (c) undo import. **Original file names aren't stored either** (they contain client IDs); only the hash, kind and date range are kept | Privacy invariant 10 |
| Q10 | Name → ISIN | **No bundled security master** (NSE's terms forbid copying or redistribution without permission). Resolution order: <br>① ISIN in the row; <br>② **transaction join** to any imported Dhan statement (date + qty → statement name → ISIN); <br>③ learned aliases; <br>④ manual mapping with suggestions. FIFO works before resolution | 36/36 resolved by the join vs 34/36 by name (A4); NSE terms |
| Q11 | R-multiple and breakeven | **R = net P&L ÷ planned risk.** Planned risk = the ₹ amount the user enters, else Σ over entry fills of \|fill price − *initial* stop\| × qty. Moving the stop later never changes R. **Breakeven** = \|net\| ≤ threshold (setting, default ₹0); breakeven trades are excluded from the win-rate denominator | Van Tharp and Tradervue convention; covers scale-ins honestly |
| Q12 | Numbers | <br>• Tolerances: Dhan per (date, scrip) component ±₹0.01; **STT and stamp duty compared per day** ±₹0.00 on the rupee total (per-scrip allocation drift is ignored). Zerodha per lot ±₹0.01, re-derived from a matching-FY file. <br>• File limit 25 MB and 200k rows. <br>• Backups: keep the last 10, plus every pre-migration backup. <br>• Performance targets as in §12 | Statements are paise-rounded; tradebooks are under 1 MB |
| Q13 | Fee rates per FY | Rule files are versioned by effective date and **must pass golden tests against every statement period we hold** (FY 2024-25 Dhan now; more as samples arrive). Known change points include NSE txn 0.00322% → 0.00297% on 1 Oct 2024, and IPFT and txn rates changing again later | A5 |

**New v1 capability from the research (D11 extension): opening lots from broker statements**
- The Dhan Tax Report and the Zerodha Tax P&L list FIFO lots with buy date, quantity, value and ISIN. That includes lots the trade file lacks, such as IPO allotments (A3) and positions bought before the file starts.
- When an orphan sell is found and a matching statement lot exists, the issues inbox offers **"Fill from broker statement"**. This creates an `opening_lot` adjustment with `source=broker_statement`. The user confirms it; it's never automatic.
- This replaces the brief's "later (v1.1+)" item. Manual opening lots stay as the fallback.

---

## 14. Non-goals (v1)

These are not owned by this PRD (see brief §6 and §7):
- live or API sync, credentials, Drive sync;
- F&O, MCX, currency, mutual funds;
- market data, charts, MAE/MFE, benchmarks, unrealised P&L;
- tax reports and filing;
- contract-note PDFs;
- MTF interest and ledger cash flows;
- automatic corporate-action feeds;
- desktop installers;
- multi-user use; any server or telemetry;
- AI insights.

---

## 15. Milestones and effort (re-estimated)

The brief estimated ~12.5 weeks. The export findings add Dhan instrument resolution, the coverage and issues system, two reconciliation importers, and CONVERSION/DEMERGER corporate actions, giving **about 15.5 weeks at ~12 hrs/week** (including opening lots from statements and the external tradebook).

| # | Milestone | Est. | Exit criteria |
| :--- | :--- | :--- | :--- |
| M0 | Stack chosen, repo set up, CI, ADRs for C1–C5 | 0.5 wk | ADRs merged; `npx` hello-world bound to `127.0.0.1` with a token |
| M1 | `@bhavbook/core` money and time primitives | 0.5 wk | 100% coverage; float-free lint rule |
| M2 | Vault schema, migrations, backup/restore | 1.5 wk | Restore-and-migrate test green |
| M3 | Adapters: Zerodha tradebook (incl. external), Dhan trade history; import batches, dedup, undo, wrong-account heuristic | 2 wk | Real fixtures parse; re-import adds 0 rows |
| M4 | Instrument resolution: transaction join, aliases, manual mapping; Dhan statement importers (tax report, DP charges) | 1 wk | 36/36 FY 2024-25 Dhan names resolve |
| M5 | Reconstruction: buckets, same-day netting, FIFO, positions, INCOMPLETE, opening lots (manual + from broker statements) | 3 wk | E1–E12 green; Dhan FIFO = Tax Report |
| M6 | Corporate actions (split, bonus, then conversion and demerger) | 1 wk | E8 plus the Tata cases |
| M7 | Fee engine (contract-note rounding) plus reconciliation (Dhan Global Txns, Zerodha Tax P&L) | 2 wk | Dhan FY 2024-25: STT and stamp duty exact per day; other components ±₹0.01 per row |
| M8 | UI: onboarding, import wizard, coverage, issues inbox | 1.5 wk | E2E import flow |
| M9 | Journal: review queue, position detail, tags, screenshots | 1.5 wk | — |
| M10 | Analytics and dashboard | 1.5 wk | Metrics match hand-computed fixtures |
| M11 | Packaging, docs, sanitiser pass, launch | 0.5 wk | Sanitiser PASS; README quick start under 10 minutes |

---

## 16. Handoff

- **Ready for direct implementation?** Yes, once the ADRs are recorded. All product and architecture questions are decided (§13), and the stack is chosen (§12.1).
- **Remaining inputs (they don't block M0–M2):**
  - a Zerodha **external tradebook** sample;
  - a Zerodha **Tax P&L for FY 2025-26**, to set the Zerodha golden tolerances;
  - Dhan statements for FY 2025-26 onwards, for more fee-rule golden periods.

**Next ECC lanes, in order:**
1. **`architecture-decision-records`:** **Done**: see [`docs/adr/`](../adr/README.md) (ADR-0001…0026); `domain.md` updated.
2. **`blueprint`:** turn §15 into PR-sized steps.
3. **`project-init`:** set up the TypeScript stack from §12.1.
4. **`tdd-workflow`:** starting with M1 (money and time) and the golden fixtures.
