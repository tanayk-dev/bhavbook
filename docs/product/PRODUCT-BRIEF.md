# BhavBook — Product Brief

- **Status:** v1.0 brief (supersedes the scope in [`reference/bhavbook_prd_architecture_specification.md`](reference/bhavbook_prd_architecture_specification.md); that file stays as a reference library for broker quirks, schemas, and fee mechanics)
- **Date:** 2026-10-18
- **Next phase:** done. See [`PRD.md`](PRD.md) (the PRD and capability contract)

---

## 1. One-Liner

**BhavBook is a free, open-source, local-first trade journal for Indian swing and positional equity traders who trade across multiple brokers — it turns scattered broker tradebooks into one honest record of what works for you and what costs you money.**

---

## 2. Who It's For

### Primary persona — "The Multi-Broker Swing Trader"

- Trades **equity cash (delivery)** on NSE/BSE with holding periods of **days to months**; occasional intraday.
- Uses **2–3 brokers** (e.g. Zerodha for the main swing book, Dhan for a second account or a family member's account, Groww or Upstox for long-term picks).
- Makes roughly **5–40 trades a month**: few enough to journal each one, too many to analyse in Excel.
- Wants to **improve as a trader**: which setups have positive expectancy, whether they cut winners early, whether they hold losers too long, what mistakes keep repeating.
- Privacy-conscious: does not want to upload PAN, tradebooks, or strategy notes to a hosted service.
- Comfortable enough with tech to run one terminal command (early adopter for the v1 `npx` distribution).

### Explicitly not the v1 user

- F&O option buyers/sellers (multi-leg, expiry, lot sizes): designed for later, excluded from v1.
- Pure long-term investors who want a portfolio tracker (XIRR, dividends, allocation).
- Algo traders who want live risk controls.
- CAs and tax filers who need a filing-grade tax report.

---

## 3. The Pain

| Pain | How it shows up | What they do today |
| :--- | :--- | :--- |
| **Fragmented record** | Trades are spread over 2–3 broker back-offices, each with a different CSV/XLSX format | Download each tradebook and copy it into an Excel sheet by hand |
| **No trade-level truth** | Brokers report *fills*, not *positions*. A swing position built over 3 buys and closed over 2 sells is 5 unconnected rows | Mentally group them, or don't |
| **Cost basis breaks** | Splits, bonuses, and demergers silently corrupt average price and P&L in home-made sheets | Fix it manually, often wrongly |
| **Hidden costs** | Delivery STT on both sides, DP charges, and GST eat into small swing wins; nobody sees per-trade net P&L | Look at the broker's P&L report once a year |
| **No feedback loop** | No link between *why* a trade was taken (setup, thesis, planned stop) and *how* it ended | Keep a notes app or a diary that never gets reviewed |
| **Privacy and lock-in** | Indian SaaS journals (₹499–₹1,999/mo) hold PAN and trades on their servers; global journals don't understand Indian charges or symbols | Stay with Excel |

**Severity hypothesis (to validate):** the pain is chronic rather than acute. Traders feel it at month-end reviews, after a losing streak, and at tax time. The product must make the weekly review effortless or it won't stick.

---

## 4. Why Now

- **Indian retail participation keeps growing**, and SEBI's repeated studies on retail trading losses have made "know your real numbers" part of mainstream trader discussion.
- **Multi-broker is now normal.** Zero-brokerage delivery from discount brokers and easy account opening mean serious traders hold several demat accounts.
- **Local-first tooling has matured** (embedded SQLite, good local web stacks), so a serverless, private app is cheap to build and costs nothing to run.
- **No credible open-source India-native journal exists.** Global open-source journals don't handle Indian charges, symbols, or broker formats. Indian journals are all paid SaaS.

---

## 5. The 10-Star Version (North Star, not the plan)

A trader opens BhavBook on Sunday evening. All accounts across every broker, including family accounts, are already up to date. Every position is reconstructed from fills, adjusted for corporate actions, and costed to the paisa, with any broker overcharge flagged. The weekly review is waiting: each closed trade shows its setup, planned vs actual R, a daily chart with entries and exits, and how it did against Nifty. The app says, unprompted: *"Your breakout setup has +0.6R expectancy, but you exit winners 40% earlier than plan. Your averaging-down trades are −1.2R and cost you ₹38,400 this year."* In March it suggests tax-loss harvesting candidates, and in July it exports a clean STCG/LTCG schedule for the CA. None of the data has ever left the machine.

---

## 6. The MVP (v1.0): "Import, Reconstruct, Reflect"

**Thesis to prove:** *A multi-broker swing trader will import their history and use BhavBook for a weekly review, because it shows them their real per-trade, per-setup performance in a way Excel and broker reports can't.*

### In scope

1. **Workspace basics**
   - One vault on disk, multiple **broker accounts**, grouped into **profiles** (e.g. "Swing", "Long-term", "Family").
   - The 3-tier hierarchy (PAN → Profile → Broker Account) is kept in the data model, but the v1 UI exposes only Profiles → Accounts.
2. **CSV/XLSX import** for 2 brokers:
   1. **Zerodha** Console tradebook (infer intraday vs delivery, because the CSV has no product column)
   2. **Dhan** tradebook CSV/XLSX (explicit product column; parse human-readable symbols)
   - Groww and Upstox follow in v1.1, then other brokers (see §12).
   - Idempotent re-import, deduplicated on `(broker_account_id, external_trade_id)`. Dhan has no trade ID, so its key is synthetic.
   - **Multi-file import plus a coverage view.** Positions with history missing from the imports are flagged, and the user can fix them manually (see D11).
   - F&O, currency, and commodity rows are **detected, skipped, and reported** ("37 F&O rows skipped — not supported yet").
   - A pluggable adapter interface with fixture tests, so community contributors can add brokers.
3. **Position reconstruction**
   - Partial fills → orders → **positions** (one position covers its whole lifecycle, including scale-ins and scale-outs).
   - FIFO per account per product type; never across accounts or profiles.
   - **Manual corporate actions:** splits and bonuses entered by the user, then applied to cost basis.
4. **Hybrid costs**
   - Per-trade charges are computed by the versioned `@bhavbook/core` fee engine and labelled **"estimated"**.
   - Where the user imports a broker's P&L or charges statement, the period totals are **reconciled** and any discrepancy is shown. Broker-reported numbers win.
   - All money is stored as integer micro-rupees.
5. **Journaling**
   - A setup or playbook tag, entry thesis, planned stop and target (giving R-multiple), mistake tags, a post-exit review note, and pasted screenshots stored locally as `.webp`.
6. **Review analytics**
   - Gross vs net P&L, win rate, expectancy, profit factor, average winner vs average loser, average R, and holding period.
   - Each sliced **by setup, by mistake tag, by profile/account, and by month**.
   - A calendar heatmap, an equity curve, and "cost of mistakes" (total net P&L of trades tagged with each mistake).
   - Holding-period display (short-term < 12 months vs long-term), shown for information only, not as a tax report.
7. **Backup**
   - A one-click `.bhav` export and import, using `VACUUM INTO` plus SHA-256 verification.
   - Rolling local auto-backups.
8. **Distribution**
   - `npx bhavbook` starts a local web UI bound to `127.0.0.1` only.

### Out of scope for v1

- Live broker API sync, OAuth, and stored broker credentials. v1 stores **no broker secrets at all**, which removes a whole category of security risk.
- Google Drive sync.
- F&O (single-leg or multi-leg), MCX, and currency.
- Charts and execution plots, market data, MAE/MFE, and benchmark overlays.
- Tax reports (STCG/LTCG schedules, 44AB, ITR export).
- Desktop installers and Docker.
- Automatic corporate-action feeds.
- Contract-note PDF parsing.

### Rough effort (solo, ~12 hrs/week)

| Block | Est. |
| :--- | :--- |
| Vault, schema, migrations, backup/restore | 1.5 wks |
| Zerodha + Dhan adapters + fixtures | 2 wks |
| Position reconstruction + FIFO + corporate actions | 2.5 wks |
| Fee engine (equity delivery + intraday, versioned) + reconciliation | 2 wks |
| Journal UI + tagging + screenshots | 1.5 wks |
| Analytics + dashboard | 2 wks |
| Packaging, docs, launch | 1 wk |
| **Total** | **~12.5 weeks (~3 months)** |

> **Scope pressure valve:** if v1 slips, cut manual corporate actions down to splits only (bonuses in v1.1) before cutting a broker. The Groww and Upstox adapters (v1.1) are good first tasks for community contributors.

---

## 7. Anti-Goals (what we will not build)

- **No server, telemetry, or accounts.** Ever. No BhavBook-operated backend.
- **No trading actions.** BhavBook never places, modifies, or cancels orders; no kill-switch. It is a read-only mirror of history.
- **No tax filing advice.** Holding-period and tax-bucket views are informational. Filing-grade output, if it ever exists, is framed as "export for your CA."
- **No market-data redistribution.** We will not bundle or re-host exchange data. Any future chart data comes from a source the user brings themselves (their own broker API or files).
- **No F&O-first features** until the equity journal has users.
- **No "AI insights" layer** in v1. Plain, correct aggregates come first.

---

## 8. How We Know It's Working

There is no telemetry, so success is measured through open signals and direct user feedback.

| Signal | v1 target (within 3 months of launch) |
| :--- | :--- |
| **Founder dogfooding:** the author does a weekly review in BhavBook | 8 consecutive weeks |
| **Correctness:** realized P&L per account matches the broker's own P&L report | Exact match on gross; net within reported reconciliation tolerance, with discrepancies explained |
| **Time-to-first-insight:** from `npx bhavbook` to seeing per-setup stats on one's own history | < 10 minutes |
| **Design partners:** real traders using it on their own data | 5 people, at least 3 still using it after 4 weeks (asked directly) |
| **Community:** GitHub stars / npm weekly downloads | 300 stars / 100 weekly downloads |
| **Contributor proof:** a broker adapter merged from an outside contributor | ≥ 1 |

---

## 9. Key Product Decisions

| # | Decision | Rationale |
| :--- | :--- | :--- |
| D1 | Beachhead = multi-broker swing/positional equity trader | The author's own use case; the pain is broad and F&O complexity is avoided |
| D2 | Trade journal, not portfolio tracker | Keeps v1 focused on self-improvement; holdings are a by-product |
| D3 | F&O excluded and rows skipped transparently | Avoids lot sizes, expiries, and multi-leg grouping in v1 while staying honest with users |
| D4 | CSV/XLSX import only, no live API in v1 | Swing traders don't need same-day sync; no secrets to store; much less to build |
| D5 | Hybrid costs: engine estimates, broker statements win | Reduces the trust risk of the engine disagreeing with the broker; overcharge detection is a later hook |
| D6 | Local web via `npx`, bound to 127.0.0.1 | Fastest path for a solo TypeScript developer; a desktop wrapper (Tauri) comes in v2 |
| D7 | SQLite `STRICT` with micro-rupee integers; DuckDB deferred | Settles the "decision pending" question; v1 has no time-series workload |
| D8 | License: **MIT** | Community open source with no business to protect; MIT maximises adoption and contributions |
| D9 | Corporate actions entered manually in v1 | Cost basis is wrong without them; auto-feeds are a data-sourcing problem for later |
| D10 | Broker order: **Zerodha + Dhan** (v1.0) → **Groww + Upstox** (v1.1) → others | The brokers the author and first users actually use; two adapters keep v1 shippable |
| D11 | **Incomplete history is expected, not an error.** Multi-file import, a coverage view, warnings, and manual fixes as separate records (see below) | Zerodha caps tradebooks at 365 days and users rarely download everything; real data already has sells with no buys |

### D11 in detail: handling incomplete history

1. **Multi-file import.** The user drops any number of files in any order. Overlaps deduplicate safely (Zerodha `trade_id`; Dhan synthetic key). We suggest FY-wise downloads but don't require them.
2. **Coverage view per account.** It shows a timeline of the date ranges imported, with gaps highlighted ("No Zerodha trades between 2024-09-12 and 2025-09-11. Import that tradebook?").
3. **Integrity checks after every import.** Examples:
   - A sell with no earlier buy, or more shares sold than held.
   - A position still open for longer than plausible.
   - Holdings that a broker statement says exist but the trades don't explain.

   Quantities never go negative.
4. **Warning labels.** Every affected position gets an **"Incomplete: entry missing"** badge. These positions are **left out of the analytics by default**, and every chart says so ("4 positions excluded, history incomplete").
5. **Ways to fix it, in the order we suggest them:**
   1. Import the older file. The checks rerun and the warning clears by itself.
   2. Add an **opening lot**: quantity, average cost, and date (or "before \<date\>").
   3. Mark the position "exclude from analytics".
6. **Manual fixes never edit imported rows.** They are stored as separate, labelled adjustment records (`source = manual`) that can be undone. Imported data stays exactly as the broker sent it, and re-imports never overwrite a fix. If a later import covers a gap where the user added an opening lot, the app offers to replace the manual lot with the real trades.
7. **Later (v1.1+):** use the broker's opening-position data where it exists as the opening balance, for example the Zerodha Tax P&L sheet "Open Positions as of \<FY start\>".

---

## 10. Risks & Mitigations

| Risk | Severity | Mitigation |
| :--- | :--- | :--- |
| **Broker formats change without notice** | High | Fixture tests per format version; clear parse-error UI; an adapter template so contributors can fix them fast |
| **Tradebooks don't contain charges**, so hybrid reconciliation depends on a second file the user must download | High | Make the engine estimate good enough on its own; make the statement import optional but encouraged; validate in the PRD which broker reports carry charges |
| **Fee rates drift** (Budget changes, exchange circulars) | Medium | Rules versioned by effective date; golden-value tests; a documented "update the rule file" contribution path; verify the FY26-27 matrix against primary sources before building |
| **Zerodha intraday-vs-delivery inference is wrong** for some edge cases (e.g. a BTST that nets to zero on the same day) | Medium | Show inferred product type and let the user override it per trade |
| **Corporate actions missed**, giving wrong cost basis | Medium | Detect impossible states (selling more than held, price jumps around ex-dates) and prompt the user |
| **`npx` excludes non-technical traders** | Medium | Accept this for early adopters; v2 adds a desktop installer |
| **Solo part-time burnout or slip** | High | The pressure valve (2 brokers first); strict anti-goals; recruit adapter contributors early |
| **Low retention:** users import once and never return | High | Design around the **weekly review ritual** (pending-review queue, "trades needing journal" count) |

---

## 11. Assumptions to Validate Before or During the PRD

1. **Design partners:** find 5 swing traders (friends or trading communities) willing to share **anonymised** tradebooks for fixtures and to try v1.
2. **Charges data:** which Zerodha and Dhan reports include per-trade or per-period charges, and in what format? (Repeat for Groww and Upstox before v1.1.)
3. **Corporate actions in exports:** do broker tradebooks reflect splits and bonuses (adjusted quantities) or not?
4. **Journal friction:** will traders fill in setup, planned stop, and target *after* the fact? If not, which fields should be optional or inferred?
5. **Fee matrix:** re-verify every FY26-27 rate (STT, exchange, SEBI, IPFT, stamp duty, DP) against primary sources.

---

## 12. Roadmap Sketch (direction, not commitment)

| Release | Theme | Headline features |
| :--- | :--- | :--- |
| **v1.0** | Import, Reconstruct, Reflect | Covered in §6 |
| **v1.1** | Next brokers | Groww (stocks order history, executed rows only) + Upstox (skip metadata header rows) adapters |
| **v1.x** | Breadth | Angel One + more adapters (community), multi-PAN UI, improved reconciliation, overcharge flags |
| **v2.0** | See the trade | Desktop app (Tauri), daily-candle charts with entry/exit markers (user-supplied data), MAE/MFE on daily bars, Nifty benchmark comparison |
| **v2.x** | Stay in sync | Read-only broker API import (Upstox analytics token, Dhan historical trades, Kite), Google Drive `drive.appdata` backup |
| **v3.0** | Tax season | STCG/LTCG schedules, tax-loss harvesting scanner, CA export |
| **Later / maybe** | F&O | Single-leg first, then multi-leg strategies, lot-size history, expiry logic |

---

## 13. Go / No-Go

**Recommendation: GO, with a narrowed scope.**

- The pain is real, the author is a member of the target segment (which gives fast feedback), and there is a clear open-source gap for an India-native, private journal.
- The original specification's scope (15 feature areas in 7 months) was a **no-go** for a solo part-time builder. The v1 defined here is achievable in about 3 months.
- **Conditions:**
  1. Collect anonymised sample files for Zerodha and Dhan before building their parsers.
  2. Line up at least 3 design partners before launch.
  3. Hold to the anti-goals.

---

## 14. Next Step

Hand this brief to **`product-capability`** to produce the new implementation-ready PRD. It should cover:

1. The data model (vault, profile, account, fill, order, position, corporate action, journal entry, tag).
2. The position-reconstruction and FIFO rules, with worked examples (scale-in/out, split, bonus, same-day net-zero).
3. Adapter contracts and the fixture strategy for Zerodha and Dhan, designed so Groww and Upstox drop in for v1.1.
4. The fee-engine scope for equity delivery and intraday, plus the reconciliation contract.
5. Metric definitions (expectancy, R, profit factor, holding period), including edge cases.
6. UI flows: onboarding/import, the review queue, the trade detail page, and the dashboard.
7. Non-functional requirements: privacy, `127.0.0.1` binding, backup integrity, migrations, and the test strategy.
