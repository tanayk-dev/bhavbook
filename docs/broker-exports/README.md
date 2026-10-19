# Broker Export Samples

Real-format broker exports used to design the parsers. Later they become fixture tests.
The analysis for each broker is in [`zerodha/NOTES.md`](zerodha/NOTES.md) and [`dhan/NOTES.md`](dhan/NOTES.md).

> **Privacy (rescanned 2026-10-19):** the files have been scrubbed. Three small items remain (see the checklist below). **Keep this folder out of any public repo anyway.** When the git repo is created, add this folder to `.gitignore`, and commit only scrubbed copies under the parser packages' `fixtures/`. Run the `ecc:opensource-sanitizer` agent over the fixtures before any public push.

## Layout

| Folder | Report | Role in v1 |
| :--- | :--- | :--- |
| `zerodha/tradebook/` | Console Tradebook CSV (≤365 days per file) | **Primary import** |
| `zerodha/tradebook-external/` | External tradebook (corporate actions, IPO, transfers) | Corporate actions and opening lots (*still needed*) |
| `zerodha/tax-pnl/` | Tax P&L XLSX (per FY) | Golden FIFO and per-lot charges; optional reconciliation import |
| `zerodha/agts/` | Annual Global Transaction Statement XLSX (per FY) | Checks per-symbol yearly totals |
| `zerodha/pnl/` | P&L XLSX | Nice to have (*current file is empty*) |
| `dhan/past-trades/` | All Exchange Transactions CSV (any range) | **Primary import** |
| `dhan/global-tnx/` | Global Transactions CSV (per FY) | Per-scrip, per-day charges, used for fee reconciliation |
| `dhan/tax-report/` | Tax Report `.xls` (per FY) | Golden FIFO, name→ISIN mapping |
| `dhan/dp-charges/` | DP Transaction Charges CSV (per FY) | DP charges, name→ISIN mapping |
| `dhan/pnl/`, `dhan/pnl-realised/` | P&L / Realised P&L CSV (per FY) | Checks yearly totals |
| `dhan/ledger/`, `dhan/funds-summary/` | Ledger / Fund Summary CSV (per FY) | Not in v1 (cash flows later) |

## Cross-broker findings that change the PRD

| # | Finding | Zerodha | Dhan | Consequence |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **What a row means** | Exchange fill (`trade_id`) | Order or aggregate, no IDs | The canonical model has to accept fill-level *or* order-level rows |
| 2 | **Price fidelity** | float32 noise (`700.599976`) | Rounded average; `Trade Value` is exact | Per-broker normalisation: Zerodha → round to paise; Dhan → value is authoritative |
| 3 | **Dedup key** | `trade_id` | None | Synthetic content-hash key for Dhan; the domain rule needs a broker-specific dedup strategy |
| 4 | **Instrument identity** | Symbol + ISIN (sometimes blank) | Display name only | Instrument resolver: ISIN first, then a symbol/name → ISIN map, then manual mapping |
| 5 | **Product type** | Absent (infer) | `DELIVERY`/`INTRADAY`/`MTF` | v1 must handle MTF as its own product type (no interest ledger) |
| 6 | **Exchange** | NSE buy → BSE sell happens | NSE only | FIFO is keyed on ISIN per account, not on exchange |
| 7 | **History depth** | ≤365 days per file | Unlimited | Multi-file import with overlap-safe dedup; opening-position import or warnings |
| 8 | **Charges source** | Tax P&L: per FIFO lot, 4 dp | Global Txns: per scrip per day, 2 dp; Tax Report: per lot, total only | Two reconciliation granularities; compare with tolerance |
| 9 | **Spreadsheet formats** | `.xlsx` with an offset header block | Legacy `.xls` plus CSVs with metadata headers and footers | The parser library must read `.xls` (BIFF) as well as `.xlsx` |
| 10 | **Out-of-scope rows** | Mutual funds (Coin) | — | Detect and skip, like F&O |

## Scrubbing checklist

- [ ] **File names:** remove the client ID. Zerodha is done. ⚠️ The **Dhan `past-trades/TRADE_HISTORY_CSV_<ID>_…csv`** file name still contains the real client ID.
- [x] **Cell values:** name, PAN, client ID/UCC and narrations are replaced in all the Zerodha files and in the Dhan `.xls`.
  - ⚠️ The Dhan Journal CSVs (6 files) still have the **real first name** in the `Name,` row.
  - 🟡 The Dhan `.xls` still has Dhan's own *partial* masking of mobile and email (first and last 2 characters visible). That's low risk, but replace them before using the file as a public fixture.
- [x] **Rows replaced, not deleted**; header and metadata blocks kept.
- [x] **CSV files are byte-faithful** (quoting, the `NOTE :` footer with no trailing newline, and Zerodha's float32 prices are all intact).
- [ ] **XLSX/XLS files:** editing in Excel is fine, but keep the sheet names, blank rows and cell formats, and save `.xls` as `.xls`, not `.xlsx`.
- [ ] Bank names (in Dhan's Fund Summary) are low risk, but you can replace them too.
- [ ] No contract-note PDFs.
