# Dhan Export Notes

> Analysed 2026-10-19. The account is equity-only (NSE). The FY-wise reports cover FY 2024-25.

## Files provided

| Folder / file | Report | Period | Format | Scrubbed? |
| :--- | :--- | :--- | :--- | :--- |
| `past-trades/TRADE_HISTORY_CSV_<CLIENT_ID>_…csv` | All Exchange Transactions (Past Trades) | 2024-04-22 → 2026-10-15 (116 rows, 42 scrips) | CSV | ⚠️ Real client ID still in the file name |
| `pnl/Dhan_P&L_…csv` | P&L | FY 2024-25 | CSV | ⚠️ Real first name still in the `Name,` row |
| `pnl-realised/Dhan_Realised_P&L_…csv` | Realised P&L | FY 2024-25 | CSV | Same as above |
| `global-tnx/Dhan_GlobalTransction_Report_…csv` | Global Transactions | FY 2024-25 | CSV | Same as above |
| `ledger/Dhan_Ledger_…csv` | Ledger Summary | FY 2024-25 | CSV | Same as above |
| `dp-charges/Dhan_DPCharges_…csv` | DP Transaction Charges | FY 2024-25 | CSV | Same as above |
| `funds-summary/Dhan_Funds_Summary_…csv` | Fund Summary | FY 2024-25 | CSV | Same as above; bank name visible |
| `tax-report/tax-pnl-report.xls` | Tax Report | FY 2024-25 | **Legacy `.xls` (BIFF/OLE2)**, 8 sheets | ✅ Name, UCC and narrations replaced; 🟡 Dhan's partial masking of mobile and email remains |

## How to download

| Report | Where | Range | Format |
| :--- | :--- | :--- | :--- |
| All Exchange Transactions | `web.dhan.co/index/profile` → Statements & Reports → Generate statement for "All Exchange Transactions" | **Any custom range** (no day or FY limit) | CSV |
| P&L | `journal.dhan.co/Statements-And-Reports/equity-fno/p&l` | Per FY | CSV |
| Realised P&L | `…/equity-fno/realised-p&l` | Per FY | CSV |
| Ledger Summary | `…/equity-fno/ledger` | Per FY | CSV |
| Global Transactions | `…/equity-fno/global` | Per FY | CSV |
| DP Transaction Charges | `…/equity-fno/dp-transction` | Per FY | CSV |
| Fund Summary | `…/equity-fno/fund` | Per FY | CSV |
| Tax Report | `journal.dhan.co/Tax-Saving/tax-report` | Per FY | `.xls` |
| Contract Note | Email only, **one day per request** | — | — (skip) |
| Holdings Summary | Email only | — | — (skip) |

## Shared CSV layout (all Journal CSVs)

```
<Report title>,From dd-mm-yyyy to dd-mm-yyyy
Name,<name>
UCC,<client id>
Mobile,<mobile>
Email ID,<email>
<blank>
<header row>
<data rows, every value quoted>
<blank>
<summary key,value pairs on one line, e.g. Net P&L,-7219.12,Brokerage,…>
<blank>
NOTE : This sheet was downloaded at mm/dd/yyyy hh:mm AM/PM      ← no trailing newline
```

To parse it: find the header row by its known column names, read until the first blank line, then parse the summary line as key/value pairs. Date formats differ between reports: `dd Mon yyyy`, `dd-mm-yyyy`, `dd Mon yyyy HH:MM:SS`, and `mm/dd/yyyy` in the footer.

## Report structures

### All Exchange Transactions: the primary import

```
Date,Time,Name,Buy/Sell,Order,Exchange,Segment,Quantity/Lot,Trade Price,Trade Value,Status
2026-10-15,11:36:25,Marine Electricals,SELL,DELIVERY,NSE,Equity,20,435.00,8700.00,Traded
```

There's no metadata header block. The header is row 1 and the file is sorted newest first.

### Global Transactions: charges per scrip per day (contract-note equivalent)

```
Date,Scrip Name,Exchange,Bill No.,Buy Qty.,Buy Value,Sell Qty.,Sell Value,Brokerage,GST,STT,SEBI Fees,Stamp Duty,Txn. Charges,Oth. Charges,Gross Amount
```

- One row per (trade date, scrip) with the **full charge breakdown, rounded to paise**. `Oth. Charges` is IPFT plus auction charges, according to the Tax Report notes.
- The summary line carries 4-decimal totals (e.g. `Net P&L,-7219.1761`), so the per-row values are rounded but the totals are not.
- **This is the best source for hybrid fee reconciliation:** we can compare the engine's output against Dhan for each scrip on each day.

### P&L / Realised P&L

These have one row per scrip: quantities, average buy/sell prices, values, realised and unrealised P&L, and %. The summary line is `Net P&L, Brokerage, Gross P&L, Total Charges`. They're useful for checking the year's totals.

### DP Transaction Charges

```
Date,Scrip Name,ISIN,Quantity,Type of Transaction,Charges
```

There's one ₹12.50 row per scrip sold per day, plus a separate "Total GST for DP Transactions <date>" row (`ISIN = NA`, type `SERVICETAX`). **This is the only Journal CSV with ISINs.**

### Ledger / Fund Summary

These are money movements. The ledger shows one "Trades Executed" bill entry per day plus DP and DDPI charges. They're not needed for v1, but could be used later for cash-flow and capital-based returns.

### Tax Report `.xls`: the golden reference for FIFO

- The sheets are `Equity`, `F&O`, `Commodities`, `Currency`, `Global Transactions`, `Dividend Statement`, `Ledger Statement`, and `DP Charges Statement`.
- The **Equity** sheet has a summary by bucket (Intraday/Speculation, Short Term, Long Term) with a charge breakdown, then tradewise tables:
  `Sr., Security Name, ISIN, Buy Date, Buy Qty., Avg. Buy Price, Buy Value, Sell Date, Sell Qty., Avg. Sell Price, Sell Value, Holding Period, Gross P&L, Total Charges, Net P&L`
  These are **FIFO-matched with ISIN** and include total charges per matched lot.
- It contains merged and empty spacer columns (e.g. column C is always blank), so parse by header name, not column position.
- The cells hold binary floats (`293116.94999999995`), so round to paise when reading.
- The notes confirm FIFO, values at the traded price excluding levies, and `Other Charges = IPFT + Auction`.

## Findings that matter for BhavBook

1. **🔴 Trade rows have no trade ID or order ID.** The rule "deduplicate on `(broker_account_id, external_trade_id)`" can't work for Dhan. A **synthetic key** is needed, e.g. a hash of (date, time, name, side, product, qty, value) plus an occurrence index for identical rows. I found no exact duplicates in this file, but 8 groups have multiple rows for the same (day, scrip, side). Re-imports with overlapping date ranges must still be idempotent.
2. **🔴 No ISIN or ticker in trade rows**, only a display name (e.g. "BlueStone Jewellery & Lifestyle"). Instrument identity has to be resolved by **name → ISIN**, using the Tax Report, the DP Charges CSV, or a bundled NSE/BSE security master. When a name can't be matched, show it to the user for manual mapping.
3. **🔴 Rows are orders (or aggregates), not exchange fills, and `Trade Price` is a rounded average.** In 16 of 116 rows, `qty × Trade Price ≠ Trade Value` (e.g. 11 × 891.97 = 9811.67 vs value 9811.70). **Treat `Trade Value` as the source of truth** and store the value in micro-rupees, deriving the average price from it. The canonical schema needs a `trade_value_micro` field and shouldn't treat `price_micro` as authoritative for every broker.
4. **🟠 `Order` column = product type:** `DELIVERY` (106), `INTRADAY` (8), and `MTF` (2). **MTF exists in real data**, so v1 has to at least map it to `MARGIN_MTF` and match it separately. An MTF position bought and sold on the same day was reported under Intraday/Speculation in the Tax Report.
5. **🟠 Segment is the word `Equity`** in trades but `CAPITAL` in the Tax Report's Global Transactions sheet. Normalise per report.
6. **🟢 The trade file covers 2.5 years in one download** (no range limit), unlike Zerodha's 365-day limit.
7. **🟢 Charges reconcile at three levels:** per scrip per day (Global Transactions), per FIFO lot (Tax Report, total charges only), and per year (P&L summary line). That's a strong base for the hybrid fee approach.
8. **🟡 Contract notes and Holdings Summary are email-only.** Agreed, skip them.

## Still needed

- [ ] *(Optional; useful as golden data for later FYs)* FY-wise reports for **FY 2025-26 and FY 2026-27 (to date)**: P&L, Global Transactions, DP Charges, Tax Report. The trade file goes up to Oct 2026, but those reports only cover FY 2024-25
- [ ] Rename the trade file (client ID) and replace the first name in the 6 Journal CSVs
