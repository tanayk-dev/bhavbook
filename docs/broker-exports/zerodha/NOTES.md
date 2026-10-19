# Zerodha Export Notes

> Analysed 2026-10-19. The account is equity-only (no F&O history), so there are no F&O sample files.

## Files provided

| File | Report | Period | Format | Scrubbed? |
| :--- | :--- | :--- | :--- | :--- |
| `tradebook/tradebook-<CLIENT_ID>-EQ.csv` | Tradebook, Equity | 2025-09-12 → 2026-03-23 (121 fills, 27 symbols) | CSV | ✅ |
| `tax-pnl/taxpnl-<CLIENT_ID>-2024_2025-Q1-Q4.xlsx` | Tax P&L | FY 2024-25 | XLSX, 11 sheets | ✅ |
| `agts/agts-<CLIENT_ID>.xlsx` | Annual Global Transaction Statement | FY 2025-26 | XLSX, 5 sheets | ✅ |
| `pnl/pnl-<CLIENT_ID>.xlsx` | P&L | — | XLSX | ⚠️ **Empty**: both sheets have only one row. Needs re-downloading |

## How to download

| Report | URL | Range limit | Options |
| :--- | :--- | :--- | :--- |
| Tradebook | `console.zerodha.com/reports/tradebook` | ≤ 365 days per download | Segment (Equity, F&O, …); CSV |
| P&L | `console.zerodha.com/reports/pnl` | Any custom range | Segment; realised / unrealised / combined; XLSX |
| Tax P&L | `console.zerodha.com/reports/taxpnl` | One FY, Q1–Q4 | Segment; XLSX |
| Annual Global Statement | `console.zerodha.com/reports/downloads` → "Annual Global Statement" | One FY | XLSX |

## Report structures

### Tradebook CSV: the primary import

```
symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time
```

- **Granularity:** one row per **exchange fill**. One order had 18 fills. `trade_id` is unique within the file; `order_id` groups the fills.
- **No `product` column and no `expiry_date` column** in the equity export. The original spec's column list was wrong about `expiry_date`, at least for EQ.
- `trade_type` is lowercase `buy`/`sell`. `segment` is `EQ`. `auction` is `true`/`false`.
- `exchange` is NSE or BSE. `series` is `EQ` on NSE, and BSE groups `A` or `B` on BSE.
- `order_execution_time` looks like `2025-09-12T14:50:01`, with **no timezone** (it's IST).
- `trade_id` has **varying length (5–9 digits)** and `order_id` is 16 or 19 digits. Store both as **strings**: 19 digits overflows a JS `number`.
- File order is not chronological. It starts with Sep 2025 sells.

### Tax P&L XLSX: the golden reference for FIFO and charges

The sheets are: `Tradewise Exits from <date>`, `Equity and Non Equity`, `Mutual Funds`, `F&O`, `Currency`, `Commodity`, `Other Debits and Credits`, `Open Positions as of <FY end>`, `Open Positions as of <FY start>`, `Dividends & Interest`, and `Ledger Balances`.

- Every sheet starts with ~6 blank rows and a header block (Client ID, Name, PAN). Column A is always empty, so data starts in column B.
- **Tradewise Exits** has sections (`Equity - Intraday`, `Equity - Short Term`, `Equity - Long Term`, …), each with its own header row:
  `Symbol, ISIN, Entry Date, Exit Date, Quantity, Buy Value, Sell Value, Profit, Period of Holding, Fair Market Value, Taxable Profit, Turnover, Brokerage, Exchange Transaction Charges, IPFT, SEBI Charges, CGST, SGST, IGST, Stamp Duty, STT`
  - One row per **FIFO-matched lot** (entry lot × exit), with **charges allocated per lot to 4 decimals**. This is exactly our position-reconstruction output plus fee-engine output, which makes it ideal golden data.
  - The top of the sheet has an STCG/LTCG breakup **before/after 23 July 2024** (the rate-change date).
  - Some allocated stamp duty is **negative** (e.g. `-0.0055`), a rounding-allocation artifact. Reconcile with a tolerance, not exact equality.
- **Equity and Non Equity** has realised profit split into intraday, short-term and long-term; turnover; a charges table (with `- Z` suffixes on account heads); and "Other Credits & Debits".
- **Other Debits and Credits** has DP charges for each sale (e.g. "DP Charges for Sale of <SYMBOL> on dd/mm/yyyy", ₹15.34 or ₹15.93) and quarterly demat AMC (₹88.50). These are not in the tradebook.
- **Dividends & Interest** has symbol, ISIN, ex-date, quantity, dividend per share and net amount, plus a quarterly breakdown. Some rows are duplicated (e.g. two identical TATAMOTORS rows), so don't deduplicate them blindly.

### AGTS XLSX: annual totals

The sheets are `Equity`, `Mutual Funds`, `F&O`, `Currency`, and `Commodity`. Each has a charges table and then a table of `Symbol, Exchange, Segment, Buy Quantity, Buy Value, Sell Quantity, Sell Value`, with **one row per (symbol, exchange)**.

## Findings that matter for BhavBook

1. **🔴 Prices are float32 artifacts.** The CSV has `700.599976` for ₹700.60 and `3130.600098` for ₹3,130.60. Converting the decimal string directly to micro-rupees would store a wrong price. **Rule for equity: round the Zerodha price to 2 decimals (paise) first, then convert.** I checked this: after rounding, the tradebook matches the AGTS buy and sell values **exactly for all 32 symbol-exchange rows**. Without rounding it's off by fractions of a paisa (e.g. 99570.9994 vs 99571.00). Prices aren't all on a 0.05 tick (e.g. `169.56`, `201.99`), so don't round to a tick size, only to paise.
2. **🔴 Buy on NSE, sell on BSE.** Five symbols were bought on NSE and sold on BSE. FIFO must match on **ISIN within the account**, not on (symbol, exchange).
3. **🔴 Missing ISINs.** Two fills (FIVESTAR, ADVANCE) have an empty `isin` while other fills of the same symbol carry one. Fill the gap from the symbol→ISIN mapping in the same file, and warn if no mapping exists.
4. **🟠 Positions opened before the file starts.** Ten symbols are sold on 2025-09-12 with no matching buys in the file (a basket exit of positions bought in 2023–24). This is handled by **D11 (incomplete history)** in the product brief: multi-file import, a coverage view, an "Incomplete: entry missing" badge, and manual opening lots. Quantities never go negative.
5. **🟠 Corporate-action cases exist in this data.** TATAMOTORS is held across the Oct 2025 Tata Motors demerger, and the data includes a TATAMTRDVR (DVR share) position. Ask for the **external tradebook**: it was not provided, and the corporate-action credits live there.
6. **🟠 Intraday inference.** There are three same-day buy+sell round trips (ARIHANTCAP, ARSSBL, ADVENTHTL). In the Tax P&L, Zerodha classifies such trades as `Equity - Intraday`, which gives us a reference for testing the inference rule.
7. **🟡 Mismatched periods.** The tradebook covers FY 2025-26 (partial) but the Tax P&L covers FY 2024-25, so they can't be reconciled against each other yet. The AGTS (FY 2025-26) does line up with the tradebook.
8. **🟡 Mutual funds (Coin)** appear in the AGTS and Tax P&L. They're out of scope for v1, so detect and skip them, as with F&O.

## Still needed

- [ ] *(Optional, now that D11 exists)* Tradebook CSVs for **FY 2024-25 and earlier** (≤365 days each), so the FY 2024-25 Tax P&L can be reconciled and open positions start correctly
- [ ] Tax P&L for **FY 2025-26**, to match the existing tradebook
- [ ] **External tradebook** (Tradebook page → external trades), for corporate actions, IPO allotments and transfers in
- [ ] P&L XLSX re-downloaded (the current file is empty; try clicking View before Download)
- [x] Scrub the client ID and full name from cell values and file names
