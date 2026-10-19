# Research: resolving the PRD's open questions

- **Date:** 2026-10-19
- **Feeds:** [`../PRD.md`](../PRD.md) §13 (the decisions themselves are recorded in PRD §13 and §2)
- **Method:** (1) web research: official broker charge pages, exchange news, tax commentary, vendor and community docs; (2) **empirical tests on the real exports** in `docs/broker-exports/`, using scripts in the session scratchpad.
- **Caveat:** search returned **no Reddit or X/Twitter threads**; those platforms aren't indexed for this tool. Community input comes from TradingQnA, Kite forum, Zerodha support, Sharesight help and other journal vendors' docs instead. Where the web and our data disagree, **our data wins**, because it is what the broker actually billed.

---

## A. Evidence from our own files (the strongest)

### A1. Charges are rounded per contract note (trading day), not per trade

Test: Dhan Global Transactions FY 2024-25, 46 trading days.

- Expected STT per day = round_half_up(0.1% × delivery turnover + 0.025% × intraday sell value) → **matches on 45/46 days**.
- Expected stamp duty per day = round_half_up(0.015% × delivery buys + 0.003% × intraday buys) → **matches on 46/46 days**.
- Per-scrip STT values are **not** whole rupees. Example: 22 Apr 2024 shows 15.39 + 7.35 + 8.27 = 31.01 ≈ ₹31.
- So the broker rounds the **day total to the rupee**, then **allocates it to scrips** (paise rounding causes ±₹0.01 drift).
- The one mismatching day (18 Sep 2024) is the IPO case in A3. It involves allotted shares that aren't in the trade file.
- This matches Zerodha's published rule: STT is rounded to the nearest rupee, with ≥ 50 paise rounding up. Sources say rounding is "nearest rupee for STT and stamp duty; 2 decimals for everything else". *Our data adds that this happens at the contract-note level.*

### A2. Same-day netting decides intraday for every product type

Test: for each (IST date, scrip), `min(bought, sold)` vs the *Intraday/Speculation* lots in the Dhan Tax Report.

- **11/11 matched.** That includes **5 days where the orders were marked `DELIVERY`** and **1 `MTF` day**, all treated as intraday by Dhan for both tax and charges. (Intraday brokerage was also charged on those DELIVERY orders.)
- On 18 Sep 2024 the buy (100) was matched against the **earliest** sell order of the day (09:16:37, 100 @ 173.50 → sell value 17,350 in the tax report), not the larger later one. So intraday matching works in **time order**.
- This agrees with Zerodha and community answers: a same-day buy and sell is treated as intraday, matched FIFO.

### A3. Broker tax reports contain lots that the trade file doesn't

- The Dhan trade file shows 18 Sep 2024: buy 100, sell 300 (an orphan sell of 200).
- The Dhan Tax Report lists the missing lot: **200 @ ₹176, bought 17-09-2024 (IPO allotment)**, with its ISIN.
- So **tax reports are a ready-made source of opening lots** for incomplete history (IPOs, transfers, positions bought before the file starts).

### A4. Dhan names differ between Dhan's own reports

- The trade file says "Rural Electrification Corporation" and "HCC"; the statements say "REC" and "Hindustan Construction Company".
- Exact name matching to statement ISINs resolves 34/36 FY 2024-25 names.
- **Matching on the transaction itself** resolves **36/36 with 0 ambiguity**. The join is (date, buy qty, sell qty) → Global Transactions row → statement name → ISIN (from the Tax Report or DP Charges).

### A5. Exchange fee rates changed mid-year

- NSE's effective transaction charge in our data is ~0.00322% until Sep 2024 and ~0.00297% from Oct 2024. That is SEBI's uniform-charge circular, effective 1 Oct 2024 (₹2.97/lakh).
- Brokers' pages show different rates today: Zerodha shows 0.00307%, Dhan 0.0030699%.
- "Other charges" (IPFT) ran at ~0.0001% of turnover in FY 2024-25. Today Zerodha publishes ₹0.01/crore and Dhan 0.0000001%.
- → Rule files **must** be versioned by date, and validated against statements for every period we hold.

### A6. Zerodha ID shapes

- NSE `trade_id`s are 5–9 digits; BSE ones are 6–8 digits. Short numbers suggest they come from exchange sequences that reset (per day and per instrument), so `trade_id` alone is **not** safe as a global key.
- `order_id` is 16 digits (NSE) or 19 digits (BSE).

---

## B. Web findings

| Topic | Finding | Source |
| :--- | :--- | :--- |
| Dhan charges | Delivery brokerage ₹0; intraday and MTF ₹20 or 0.03% per executed order; STT delivery and MTF 0.1% both sides, intraday 0.025% sell; stamp duty 0.015% (delivery, MTF) or 0.003% (intraday) on buys; DP ₹12.50 + GST per ISIN per instruction; STT and stamp duty rounded to the rupee, others to 2 dp; MTF interest 12.49–15.49% p.a. by slab | [Dhan pricing](https://dhan.co/pricing) |
| Zerodha charges | Delivery ₹0; intraday 0.03% or ₹20 per order; MTF brokerage 0.3% or ₹20 per order, interest 0.04%/day, pledge ₹15 + GST; DP ₹15.34 per scrip on sell (₹3.5 CDSL + ₹9.5 Zerodha + GST); NSE 0.00307%, BSE 0.00375% | [Zerodha charges](https://zerodha.com/charges) |
| STT rounding | Rounded to the nearest rupee (≥ 50 paise rounds up) | [Zerodha support](https://support.zerodha.com/category/trading-and-markets/trading-faqs/articles/how-is-the-securities-transaction-tax-stt-calculated), [Tradejini](https://www.tradejini.com/support/knowledge-base/know-your-broker/charges/statutory-and-exchange/how-is-the-securities-transaction-tax-stt-calculated), [TradingQnA](https://tradingqna.com/t/gst-amount-round-off/164058) |
| NSE fee change | Flat ₹2.97/lakh cash market from 1 Oct 2024 (SEBI uniform-charge circular) | [Business Standard](https://www.business-standard.com/markets/stock-market-news/nse-and-bse-revise-their-transaction-fees-to-comply-with-sebi-circular-124092701207_1.html), [The Week](https://www.theweek.in/news/biz-tech/2024/09/28/nse-bse-revise-transaction-charges-effective-from-october-1.html) |
| Same-day CNC = intraday | Same-day buy and sell is treated as intraday, netted FIFO; selling holdings under MIS creates an intraday short | [Zerodha support](https://support.zerodha.com/category/console/portfolio/holdings/articles/sold-holdings-bought-back), [TradingQnA](https://tradingqna.com/t/cnc-same-day-and-next-trading-day/49667) |
| Bonus cost | Section 55(2)(aa): cost of bonus shares is **nil**; the holding period runs from the allotment date | [IndiaCorpLaw](https://indiacorplaw.in/2023/09/19/analysing-the-tax-implications-of-bonus-shares/), [KPMG](https://www.in.kpmg.com/taxflashnews/KPMG-Flash-News-Zash-Traders.pdf) |
| Tata Motors demerger | Cost split **68.85% TMPV / 31.15% TMCV**, 1:1 entitlement, record date 14 Oct 2025, holding period carries over from the original purchase | [Groww](https://groww.in/blog/tata-motors-demerger), [Business Today](https://www.businesstoday.in/personal-finance/tax/story/tata-motors-demerger-what-happens-if-you-sell-the-stocks-immediately-a-look-at-real-investor-tax-impact-502304-2025-11-14), [TradingQnA](https://tradingqna.com/t/everything-you-need-to-know-about-demerger-of-tata-motors-limited-2025/187197) (confirm against the company's filing before shipping as a preset) |
| Zerodha external trades | The Tradebook page's **"Equity (external trades)"** segment covers corporate actions, IPOs and OFS. Same page, same 365-day limit | [Zerodha support](https://support.zerodha.com/category/console/reports/articles/where-can-i-see-all-the-trades-i-ve-taken-for-a-particular-period) |
| Opening balances | Sharesight's standard fix for missing history is an opening balance (quantity plus total or average cost). Choosing the wrong date distorts returns; the most common cause is having used more than one broker; overlapping imports duplicate trades in their tool | [Sharesight: opening balance](https://help.sharesight.com/opening-balance/), [missing trades](https://help.sharesight.com/missing-trades-in-your-sharesight-portfolio), [Zerodha partner page](https://www.sharesight.com/partners/zerodha/) |
| Dedup in other tools | Navexa matches duplicates on date + quantity + price; Ghostfolio rejects duplicate activities in a batch; one Kite tool keys on trade_id per account and flags conflicts | [Navexa](https://help.navexa.com/en/articles/14628868-how-to-use-find-duplicates-in-navexa), [Ghostfolio](https://github.com/ghostfolio/ghostfolio), [kite-mcp](https://glama.ai/mcp/servers/@chandantherefore/kite-mcp/blob/032c28ae89c7f98ce47e9490bd837293cec81945/equity/DUPLICATE_DETECTION_UPDATE.md) |
| R-multiple | R = initial risk from the **initial stop** fixed at entry (Van Tharp). Tradervue lets the user enter dollar risk. When scaling, every outcome is measured against the risk written down at entry; widening the stop "quietly redefines −1R" | [Tradervue blog](https://blog.tradervue.com/?p=639), [CrossTrade](https://crosstrade.io/learn/performance-metrics/r-multiple), [LuxAlgo](https://www.luxalgo.com/library/concept/r-multiple-framework/), [TradeZella](https://help.tradezella.com/en/articles/7190710-understanding-r-multiple) |
| Security master licence | NSE's terms say website data "shall not be copied … reproduced … transmitted" without **prior written permission** | [NSE terms of use](https://www.nseindia.com/static/nse-terms-of-use), [NSE data policy](https://www.nseindia.com/market-data/nse-data-policy) |
| SheetJS | The npm `xlsx@0.18.5` package is unmaintained and has advisories (CVE-2023-30533 prototype pollution; CVE-2024-22363 ReDoS). Fixed versions (0.20.2+) are only distributed from the SheetJS CDN | [GitLab advisory](https://advisories.gitlab.com/pkg/npm/xlsx/CVE-2024-22363/), [SheetJS advisory](https://cdn.sheetjs.com/advisories/CVE-2024-22363.html), [SheetJS issue](https://git.sheetjs.com/sheetjs/sheetjs/issues/3012), [SheetJS docs](https://docs.sheetjs.com/docs/miscellany/sheet-lol) |
| `node:sqlite` | Still experimental on current LTS lines (reported stable only from Node 26) and has no transaction helper; `better-sqlite3` is mature (v12.x) | [2026 guide](https://jangwook.net/en/blog/en/node-sqlite-builtin-practical-guide-2026), [better-sqlite3](https://cdn.jsdelivr.net/gh/wiselibs/better-sqlite3@master/README.md) |
| Localhost security | Jupyter rejects non-local `Host` headers (DNS rebinding defence) and uses a token. A 2026 write-up on a Jupyter MCP server shows the risk when routes skip these checks: missing auth and missing Host/Origin checks allowed rebinding attacks. WebSocket upgrades also need Origin checks | [Jupyter config](https://coral.googlesource.com/coral-jupyter-server/+/refs/heads/master/etc/coral-jupyter-server/jupyter_notebook_config.py), [Pluto Security](https://pluto.security/blog/notebook-backdoor-jupyter-mcp-server/), [Tornado #2256](https://github.com/tornadoweb/tornado/issues/2256) |
| What competitors do | TradesViz, TradeZella, JournalPlus and others import Zerodha and Dhan via file or API; all are hosted SaaS. A TradingQnA user asked for a journal that groups pyramided orders into one trade, a gap in generic journals | [TradesViz](https://www.tradesviz.com/brokers/Dhan), [JournalPlus](https://journalplus.co/integrations), [TradingQnA](https://tradingqna.com/t/trading-journal-application/31812) |

---

## C. Things I couldn't verify (treated as risks, not facts)

- **Zerodha `trade_id` uniqueness:** no official statement found. We avoid relying on it (decision D-Q3).
- **Rounding in Zerodha's Tax P&L:** it allocates to 4 dp, with some negative values. The tolerance is derived from a matching FY's file once we have one.
- **Exact ratios for the DVR conversion and the Tata demerger:** the user enters them in v1. Presets only after checking the company filings.
