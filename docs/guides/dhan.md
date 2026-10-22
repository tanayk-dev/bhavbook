# Your Dhan files

BhavBook reads the reports Dhan lets you download from its web app and from Dhan Journal. You need the **trade
history**; the statements make the charges exact and the instruments certain.

| File | Where | Range per download | What BhavBook does with it |
| :--- | :--- | :--- | :--- |
| **All Exchange Transactions** (needed) | [web.dhan.co](https://web.dhan.co) → Profile → Statements & Reports → generate "All Exchange Transactions", CSV | Any range: take everything from your first trade | Every executed order: the positions are rebuilt from these |
| **Tax Report** | [journal.dhan.co](https://journal.dhan.co) → Tax Saving → Tax Report, `.xls` | One FY | The ISIN of each scrip (Dhan's trade rows carry only a name); Dhan's own matched lots, checked against the positions BhavBook rebuilds; lots bought before your trade history starts, offered as opening lots |
| **Global Transactions** | journal.dhan.co → Statements & Reports → Global, CSV | One FY | Dhan's own charges per scrip per day, to reconcile the estimated charges |
| **DP Transaction Charges** | journal.dhan.co → Statements & Reports → DP Transaction, CSV | One FY | The ISIN of each scrip sold from your demat (DP charges themselves stay estimated in v1) |

Download the three journal reports for **every financial year** you traded and import them together with the trade
history. Overlapping files are fine: nothing is counted twice.

## Getting the history right

- **Scrip names, not ISINs.** Dhan's trade rows name the company ("BlueStone Jewellery & Lifestyle") but give no ISIN.
  BhavBook finds the ISIN in the Tax Report or the DP charges of the same trades. A name it cannot match becomes an
  issue: choose the instrument once and every row with that name follows.
- **The trade value is the truth.** Dhan's trade price is a rounded average; BhavBook keeps the reported trade value
  and derives the price from it, so totals match Dhan's to the paisa.
- **Intraday, delivery and MTF** come from the order type in each row. Shares bought and sold on the same day are
  intraday, whatever was declared, as in Dhan's Tax Report.
- **Sells without their buys** (an IPO allotment, shares transferred in) appear as incomplete positions. Accept the
  opening lot the Tax Report offers, enter it by hand, or exclude the position.
- **Charges** are estimated from Dhan's published rates until Global Transactions covers the day; Dhan's figures then
  replace the estimates (marked ✓ instead of ≈), and any difference is raised as an issue.

## Recognised but not imported

The **P&L**, **Realised P&L**, **Ledger** and **Fund Summary** reports are recognised and set aside with a note: v1
does not need them. Contract notes and the holdings summary arrive only by email; they are not needed either. F&O
rows are skipped and counted, not imported.

## Before you import

Nothing to clean up: BhavBook skips the block with your name, client code, mobile number and email at the top of
each report and does not store the file name. See [privacy](../privacy.md).
