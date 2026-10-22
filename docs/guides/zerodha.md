# Your Zerodha files

BhavBook reads the reports Zerodha's Console lets you download. You need the **tradebook**; the other two make the
history complete and check it. Log in at [console.zerodha.com](https://console.zerodha.com) first.

| File | Where in Console | Range per download | What BhavBook does with it |
| :--- | :--- | :--- | :--- |
| **Tradebook** (needed) | Reports → Tradebook, segment **Equity**, CSV | Up to 365 days | Every executed fill: the positions are rebuilt from these |
| **External tradebook** | Reports → Tradebook → external trades | Up to 365 days | IPO allotments, transfers in and corporate-action credits, which the tradebook leaves out |
| **Tax P&L** | Reports → Tax P&L, one financial year, XLSX | One FY | Zerodha's own matched lots, checked against the positions BhavBook rebuilds (a difference is raised as an issue); and lots bought before your tradebooks start, offered as opening lots |

## Getting the history right

- **Download every year you traded.** The tradebook is limited to 365 days per download, so download one file per
  year (or per 12 months) back to your first trade, and import them all at once. Overlapping ranges are fine:
  nothing is counted twice.
- **Sells without their buys** appear when your tradebooks start after a position was opened. BhavBook marks the
  position incomplete and raises an issue instead of guessing. Import the earlier tradebook, accept an opening lot
  from a Tax P&L, enter the opening lot by hand, or exclude the position.
- **Buy on NSE, sell on BSE** is matched correctly: positions are matched on the ISIN within an account, whatever the
  exchange.
- **Intraday or delivery** is decided as Zerodha's Tax P&L does: shares bought and sold on the same day are intraday.
  The tradebook has no product column.
- **Charges** are estimated from Zerodha's published rates, rounded the way Zerodha bills them, and marked ≈. v1 does
  not yet replace them with the figures in the Tax P&L.

## Recognised but not imported

The **P&L** report and the **Annual Global Statement** are recognised and set aside with a note: v1 does not need
them. Mutual fund (Coin) and F&O rows in any file are skipped and counted, not imported.

## Before you import

Nothing to clean up: BhavBook skips the header block with your name, client ID and PAN and does not store the file
name. See [privacy](../privacy.md).
