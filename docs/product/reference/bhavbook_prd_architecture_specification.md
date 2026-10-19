# Product Requirements & Architecture Document (PRD): BhavBook (`bhav-journal`)

- **Project Name:** **BhavBook** (CLI / Package namespace: `bhav-journal` / `@bhavbook/core`)
- **Document Status:** v1.2 Master Specification (Zero-Cloud / Local-First Edition)
- **Target Market:** Indian Retail & Proprietary Traders (NSE, BSE, MCX)
- **License Model:** Open-Source (MIT / AGPLv3)
- **Architecture & Privacy Model:** 100% Local-First (Zero Central Servers) with 1-Click `.bhav` Backup & BYOC (Bring Your Own Cloud — Google Drive Sync)
- **Distribution Targets:** Native Desktop App (Tauri/Electron for Win/Mac/Linux), `npx bhavbook` Local Web Server, and Docker Container

---

## Table of Contents
1. [Problem Statement](#1-problem-statement)
2. [Proposed Solution & Zero-Cloud Architecture](#2-proposed-solution--zero-cloud-architecture)
3. [Local-First Storage, 1-Click `.bhav` Backup & Google Drive Sync](#3-local-first-storage-1-click-bhav-backup--google-drive-sync)
4. [Database Architecture Evaluation (Decision Pending)](#4-database-architecture-evaluation-decision-pending)
5. [Reverse-Engineered Competitor Matrix](#5-reverse-engineered-competitor-matrix)
6. [The 15 Core Functional Pillars](#6-the-15-core-functional-pillars)
7. [A-to-Z Feature Complexity Ranking (Easy to Tough)](#7-a-to-z-feature-complexity-ranking-easy-to-tough)
8. [Phase-Wise Execution Roadmap (v1.0 to v4.0)](#8-phase-wise-execution-roadmap-v10-to-v40)
9. [Indian Broker API Directory & Technical Quirks](#9-indian-broker-api-directory--technical-quirks)
10. [Universal CSV / Excel Tradebook Schemas](#10-universal-csv--excel-tradebook-schemas)
11. [Indian Statutory Tax & Charges Reference Matrix](#11-indian-statutory-tax--charges-reference-matrix)

---

## 1. Problem Statement

Indian retail participation in Equity, Futures & Options (F&O), and Commodities has scaled exponentially, yet traders lack a reliable, privacy-first, and India-native trading journal. Current global and domestic solutions fail Indian traders across five critical dimensions:

1. **Global Tools Ignore Indian Market Mechanics:** Leading global journals (*TradeZella, TraderSync, Edgewonk*) cost $29–$99/month, assume flat US-style commissions, fail to parse NSE/BSE weekly/monthly derivative symbols, and cannot compute Indian statutory levies (asymmetric STT, Stamp Duty, Exchange Transaction Charges, SEBI Turnover Fees, IPFT, and 18% GST).
2. **Ephemeral Broker APIs:** Indian broker APIs (*Zerodha, Dhan, Upstox, Angel One*) flush their `orderbook` and `tradebook` every night between 12:00 AM and 6:00 AM IST. If a trader misses daily syncing, API ingestion fails, forcing manual back-office CSV reconciliation.
3. **The Multi-Account & "FIFO Collision" Problem:** Serious Indian traders split capital across multiple brokers (e.g., Zerodha for Swing/Investing, Dhan for Intraday Options, and Family/HUF accounts for tax optimization). Existing tools either charge premium fees for multi-account support or merge trades across accounts, causing intraday trades (`MIS`) to collide with long-term delivery (`CNC`) holdings under naive First-In-First-Out (FIFO) matching.
4. **Partial Fills & Multi-Leg F&O Distortion:** Exchange freeze limits and illiquid strikes split a single large order into dozens of partial trades. Furthermore, logging a 4-leg Iron Condor as 4 independent trades destroys Win-Rate and Profit Factor metrics.
5. **Financial Privacy & Vendor Lock-In:** Indian traders are hesitant to upload raw contract notes, PAN details, API keys, and strategy alpha to closed-source SaaS servers that may monetize order-flow data, suffer data breaches, or shut down.

---

## 2. Proposed Solution & Zero-Cloud Architecture

Build **BhavBook**—a **100% Local-First, Open-Source Trading Journal & Portfolio Analytics Engine** engineered specifically for the Indian brokerage ecosystem. We do not host any central database or backend servers; the application runs entirely on the user's machine, and the user owns 100% of their financial data.

### Core Architectural Highlights
- **Zero-Server Local Execution:** Runs natively on the user's machine via an embedded local database. Distributed as a lightweight Desktop Application (Windows `.exe`, macOS `.dmg`, Linux `.AppImage` via Tauri/Electron) or a local localhost server (`npx bhavbook` / Docker).
- **3-Tier Workspace Hierarchy (`PAN Entity` $\rightarrow$ `Trading Profile` $\rightarrow$ `Broker Account`):**
  - **1-to-1 Mapping:** Link Dhan API to `"Intraday F&O Profile"`, Zerodha API to `"Swing Equity Profile"`, and Groww CSV to `"Core Investing Profile"`.
  - **Many-to-1 Mapping:** Aggregate multiple brokers (`Dhan + Upstox`) into a single analytical view.
  - **1-to-Many Virtual Sub-Accounts:** Auto-route trades from a single broker account into separate profiles based on product codes (`MIS`/`OPTIDX` $\rightarrow$ Intraday Profile; `CNC` held $> 1$ day $\rightarrow$ Swing Profile).
- **Hybrid Ingestion Engine:** Combines daily 3:40 PM IST automated local API pulls ("Sync Today's Bhav") with universal CSV/XLSX and password-protected Contract Note PDF parsers for historical backfilling.
- **Open JSON Statutory Tax & Fee Engine (`@bhavbook/core`):** Deterministic, auditable rule-files that compute exact rupee-level Net P&L down to the paisa for every Indian broker and segment.

---

## 3. Local-First Storage, 1-Click `.bhav` Backup & Google Drive Sync

Because BhavBook is never hosted on central servers, data durability, portability, and multi-device syncing are handled through a **"Bring Your Own Storage" (BYOS)** model:

### A. Local Vault Structure
All user data lives inside a single, transparent local directory (`~/.bhavbook/vault/`):
- `bhavbook.sqlite` (or chosen DB file): Primary relational database storing all profiles, trades, tags, and tax ledgers.
- `/market_data/`: Local cache of historical OHLCV `.parquet` files for charting and trade replay.
- `/attachments/`: Sub-directory storing chart screenshots automatically compressed to `.webp` format to keep vault sizes small ($<50\text{ MB}$ per year).
- `config.json`: User preferences, custom brokerage slab overrides, and backup schedules.
- **Credential Security:** Broker API secrets (`api_secret`, `totp_key`) are never stored in plaintext. They are encrypted at rest using **AES-256-GCM** (derived from a user Master Password via Argon2id) or stored in the native OS Keychain (Windows Credential Manager / macOS Keychain).

### B. One-Click Local Backup & One-Click Restore (`*.bhav`)
- **Hot-Safe Snapshot Generation:** Clicking **"Export 1-Click Backup"** creates a transactionally consistent snapshot of the live database without locking the UI (e.g., via SQLite `VACUUM INTO`), bundles `/attachments/` and `config.json`, and compresses them into a single timestamped archive: `BhavBook_Backup_2026-10-18.bhav` (Zstandard/ZIP format).
- **Custom Local Destination:** Users can save the `.bhav` file anywhere—local hard drive, external USB/SSD, NAS, or a local Nextcloud/OneDrive/Dropbox synced folder.
- **One-Click Import & Auto-Migration:** Clicking **"Import Backup"** and selecting any `.bhav` file verifies the SHA-256 integrity checksum, unpacks the database and screenshots, automatically runs forward schema migrations (if importing an older backup into a newer app version), and reloads the workspace immediately.
- **Rolling Local Auto-Backups:** By default, BhavBook keeps the last 7 daily local snapshots in `~/.bhavbook/backups/` to protect against accidental trade deletion.

### C. Google Drive Sync ("Bring Your Own Cloud")
- **Restricted `drive.appdata` Scope:** Users can link their personal Google account via OAuth2. BhavBook requests **only** the `https://www.googleapis.com/auth/drive.appdata` or single-folder scope—meaning the journal can *only* read/write its own backup folder and has **zero access** to the user's personal Google Drive files.
- **Client-Side Encryption Before Upload:** Optional toggle to encrypt the `.bhav` payload with the user's passphrase *before* it leaves their machine, ensuring zero-knowledge storage even on Google's servers.
- **Automated Sync Triggers:**
  1. **On Trade Sync:** Automatically uploads a fresh `.bhav` snapshot to Google Drive at 3:45 PM IST after daily broker ingestion completes.
  2. **On App Close:** Syncs changes when the user exits the application.
  3. **Manual "Sync Now" Button:** One-click push/pull in the top navigation bar.
- **Multi-Machine Conflict Resolution:** If a user runs BhavBook on both a Desktop PC and a Laptop, the app checks the remote Google Drive `manifest.json` (`last_synced_at`, `device_name`, `trade_count`, `sha256_hash`) on startup. If the cloud version is newer, it prompts a 1-click **"Pull Latest from Google Drive"** before starting the session.

---

## 4. Database Architecture Evaluation (Decision Pending)

> **Status:** `DECISION PENDING` — Evaluating the optimal embedded database engine(s) for BhavBook's dual workload:
> 1. **Transactional Workload (OLTP):** Storing PAN entities, profiles, broker credentials, raw order/trade fills, playbooks, and journal notes.
> 2. **Analytical & Time-Series Workload (OLAP):** Querying millions of 1-minute historical NSE/BSE OHLCV candles, computing MAE/MFE excursions, running "What-If" counterfactual simulations, and aggregating multi-year F&O tax turnover.

### A. Candidate Local Database Engines

| Database Engine | Primary Strength | Storage Format | Pros for BhavBook | Cons / Trade-offs |
| :--- | :--- | :--- | :--- | :--- |
| **1. SQLite** (`better-sqlite3` / `rusqlite`) | Universal standard for local OLTP, zero-config, rock-solid reliability | Single `.sqlite` file | `VACUUM INTO` makes 1-click `.bhav` hot-backups trivial; massive ORM/tooling support | Lacks strict `DECIMAL` types (uses 64-bit float `REAL`); slower on heavy columnar time-series scans (MAE/MFE) |
| **2. DuckDB** | Blazing-fast embedded columnar OLAP & time-series analytics | Single `.duckdb` file + direct `.parquet` queries | Queries 5 years of 1-min Nifty `.parquet` candles in milliseconds; can directly attach & query a `.sqlite` file via `sqlite_scanner` | Not designed for high-frequency single-row CRUD UI updates |
| **3. LibSQL** (by Turso) | Modern open-source fork of SQLite with native encryption & sync | Single `.db` file (100% SQLite compatible) | Free built-in **encryption-at-rest** (unlike paid SQLite SEE); optional delta-sync if users ever want remote replicas | Slightly newer ecosystem than vanilla SQLite |
| **4. PGlite** (by ElectricSQL) | Full PostgreSQL engine running locally in WASM / Node / Desktop | Local directory / tarball | True Postgres `NUMERIC(15,4)` financial precision, `JSONB`, and rich window functions without installing Postgres | Larger footprint (~3MB WASM bundle) and multi-file directory structure compared to a single `.sqlite` file |
| **5. SQLCipher** | Full-database AES-256 page-level encryption for SQLite | Single encrypted `.sqlite` file | Industry standard for encrypting sensitive local financial/PAN data at rest | Requires native C compilation bindings in Node/Rust builds |

### B. Architectural Options Under Consideration

- **Option 1: Pure SQLite / LibSQL (Simplicity First for v1.0 MVP)**
  - Use a single `bhavbook.sqlite` (or LibSQL) file for everything in Phase 1.
  - **Mitigation for Floating-Point Rounding:** Because SQLite lacks a native fixed-point `DECIMAL` type (which causes IEEE 754 floating-point errors like $0.1 + 0.2 = 0.30000000000000004$ during $0.025\%$ STT and $0.00297\%$ NSE fee math), all tables must use `STRICT` mode with **True Micro-Rupee Integer Storage**.
  - **True Micro-Rupee Integer Storage (`INTEGER` at $10^6$ Scale):** Store all monetary values and statutory taxes in **Micro-Rupees** (`1 Rupee = 1,000,000 Micro-Rupees` / `1 Paisa = 10,000 Micro-Rupees`, giving 6 decimal places of precision) inside 64-bit `INTEGER` columns. This eliminates floating-point rounding errors on fractional NSE/SEBI charges (such as `0.00297%` or `0.0001%`) while only rounding to 2-decimal Paisa (`÷ 1,000,000`) at the final UI display and contract-note summary layer.
- **Option 2: Hybrid SQLite + DuckDB (Recommended Target Architecture)**
  - **OLTP Layer (`bhavbook.sqlite`):** Handles all core CRUD (Profiles, Trades, Tags, Notes, Tax Ledgers) and is included in the lightweight `.bhav` Google Drive backup.
  - **OLAP Layer (`DuckDB` + `/market_data/*.parquet`):** Added in Phase 2/3 to crunch historical 1-minute NSE/BSE candles, Option Greeks snapshots, Trade Replay, and MAE/MFE forensics using DuckDB's zero-copy `sqlite_scanner`.
- **Option 3: Embedded PGlite**
  - Use PGlite if contributor ergonomics around native PostgreSQL `NUMERIC(18,4)` and `JSONB` outweigh single-file SQLite simplicity.

---

## 5. Reverse-Engineered Competitor Matrix

| Feature Category | Global SaaS (TradeZella / TraderSync / Edgewonk) | India-First SaaS (Stolo / TradeFix / TradesViz IN) | BhavBook Open-Source Differentiator |
| :--- | :--- | :--- | :--- |
| **Hosting & Data Privacy** | Cloud-only, proprietary lock-in ($29–$99/mo) | Cloud-only (₹499–₹1,999/mo); server holds your PAN & trades | **100% Local-First + 1-Click `.bhav` Backup + Google Drive Sync** (Zero subscription cost, total privacy) |
| **Broker Auto-Sync** | US/Forex/Crypto heavy; poor Indian API support | Supports 5–15 major Indian brokers | **Community-driven adapters** for 30+ Indian brokers + universal Contract Note PDF/CSV parser |
| **Multi-Account / Profiles** | Locked behind highest pricing tiers | Limited sub-account isolation | **Unlimited Profiles, Virtual Sub-Accounts & Family Multi-PAN vaults** out of the box |
| **Indian Taxes (STT/GST)** | Manual flat commission input only | Built-in or approximated | **Open, auditable JSON rule-engine** (`@bhavbook/core`) for exact broker/exchange fee slabs |
| **Multi-Leg F&O Grouping** | Basic US options chains | Strong live F&O grouping | **Visual Payoff + Adjustment Timeline** linking spot price to option strikes |
| **Tax & Audit Export** | None for India | Basic P&L CSV | **ITR-3 Tax Turnover calculator** (Section 44AB absolute F&O profit/loss sum per PAN) |

---

## 6. The 15 Core Functional Pillars

1. **Local-First Vault, 1-Click `.bhav` Backup & Google Drive Sync:** Embedded local database, single-file `.bhav` export/import, OS Keychain credential encryption, and automated Google Drive sync.
2. **Indian Broker Ingestion & Reconciliation Engine:** Direct local-to-broker OAuth sync, back-office CSV/Excel parsers, partial-fill to single-logical-trade grouping, and NSE/BSE derivative symbol decomposition.
3. **True Net P&L & Statutory Fee Calculator:** Exact segment-wise brokerage, STT/CTT, NSE/BSE transaction fees, SEBI turnover fees, IPFT, Stamp Duty, DP charges, and 18% GST.
4. **Multi-Leg F&O Strategy Architecture:** Bundling individual legs into parent strategies (Straddle, Iron Condor, Spreads), tracking rolling adjustments, 0DTE expiry filters, and normalizing P&L by "Points Captured per Lot."
5. **Quantitative & Edge Analytics:** Win Rate %, Profit Factor, Expectancy, Payoff Ratio, Max Drawdown, Sharpe/Sortino, MAE (Maximum Adverse Excursion), MFE (Maximum Favorable Excursion), R-Multiple distributions, and session time-slicing.
6. **Behavioral, Psychology & Playbook Tagging:** Structured setup playbooks, mistake tagging (`FOMO`, `Revenge Trade`, `Moved SL`), "Cost of Mistakes" counter, Tiltmeter discipline scores, and pre/post-market markdown rituals.
7. **Visuals, Charting & Trade Replay:** TradingView Lightweight Charts integration with automated Buy/Sell execution arrows, local WebP clipboard screenshot vault (`Ctrl+V` + canvas annotations), and bar-by-bar trade replay.
8. **Multi-Broker Profiles, Workspaces & Unified Risk:** Isolated FIFO matching per profile, tailored dashboards per archetype (Intraday vs. Swing vs. Investing), Multi-PAN family account management, and cross-account correlated exposure warnings.
9. **SEBI Regime & Margin Intelligence:** 50:50 cash-to-collateral ROI tracking, expiry-day 2% Extreme Loss Margin (ELM) utilization alerts, MTF (Margin Trading Facility) daily interest deduction ledgers, and time-versioned historical lot-size tables.
10. **Market Context, Greeks & Slippage Forensics:** Trigger vs. Fill slippage auditor, auto-stamped India VIX & market regime tags at entry, macro event markers (RBI MPC, Budget, Fed), and historical Option Greeks (IV, Delta, Theta, Vega) snapshots.
11. **Swing & Positional Equity Power-Tools:** Scale-in/scale-out pyramid lifecycle trees, Nifty 50 / Midcap / Market Breadth equity curve overlays, and F&O Ban / physical settlement margin warnings.
12. **Automated Indian Tax, Audit & Compliance Suite:** Section 44AB Tax Audit turnover progress bar, 4-bucket income segregation per PAN (Speculative, Non-Speculative F&O, STCG, LTCG), and March Tax-Loss Harvesting scanners.
13. **"What-If" Simulation & Strategy Optimizer:** Counterfactual equity curve toggles (*"What if I stopped trading after 11:30 AM?"*, *"What if I skipped Revenge Trades?"*) and Monte Carlo Risk-of-Ruin simulators.
14. **Live Risk Guardrails:** Real-time local WebSocket MTM monitor with automated broker Kill-Switch triggers on daily loss or overtrading breaches.
15. **Open-Source Community Hooks:** Cryptographically verified privacy-safe PnL share cards, local Telegram/Discord 3:40 PM IST daily sync bots, and Chartink/TradingView local webhook listeners.

---

## 7. A-to-Z Feature Complexity Ranking (Easy to Tough)

| Complexity | Feature Name | Est. Effort | Primary Technical Bottleneck |
| :--- | :--- | :--- | :--- |
| **1 - Trivial** | **Manual Trade Entry & Local Screenshot Vault** | 2–3 Days | Standard CRUD forms, markdown editor, clipboard paste (`Ctrl+V`) compressed to local `.webp`. |
| **1 - Trivial** | **Playbook, Setup & Mistake Tagging** | 2–3 Days | Relational many-to-many tagging schema (`FOMO`, `ORB`, `Revenge Trade`). |
| **1 - Trivial** | **Core Expectancy Dashboard** | 3–4 Days | SQL aggregations for Win Rate %, Profit Factor, Payoff Ratio, Max Drawdown. |
| **1 - Trivial** | **1-Click Local Backup Export & Import (`.bhav`)** | 2–3 Days | Hot DB snapshot + zipping `/attachments` + SHA-256 verification on restore. |
| **2 - Easy** | **Indian Statutory Tax & Fee Calculator** | 4–5 Days | Maintaining accurate asymmetric STT/Stamp Duty/Exchange slab JSON configs per broker. |
| **2 - Easy** | **Multi-Profile & Multi-Broker Isolation** | 4–5 Days | Scoping all queries and FIFO engines by `profile_id` and `product_type` (`MIS`/`CNC`/`NRML`). |
| **2 - Easy** | **Standard CSV Tradebook Parsers** | 1 Week | Handling date formats, header variations, and column shifts across Zerodha/Groww/Dhan CSVs. |
| **2 - Easy** | **Google Drive `appDataFolder` Auto-Sync** | 4–5 Days | Google OAuth2 Desktop flow, multipart `.bhav` archive upload, and remote `manifest.json` timestamp check. |
| **3 - Medium** | **Partial-Fill to Logical Trade Grouping** | 1–2 Weeks | Grouping multiple exchange `trade_id` rows sharing a `parent_order_id` or net-zero position lifecycle. |
| **3 - Medium** | **NSE/BSE Derivative Symbol Parser** | 1 Week | Regex/AST parsing of inconsistent broker symbol strings (`NIFTY26OCT25000CE` vs `NIFTY 29 OCT 25000 CALL`). |
| **3 - Medium** | **Direct Local-to-Broker OAuth API Sync** | 2 Weeks | Spinning up a temporary localhost callback listener (`127.0.0.1:4567/callback`) to capture broker OAuth tokens. |
| **3 - Medium** | **TradingView Lightweight Charts Execution Plot** | 2 Weeks | Mapping trade timestamps to 1m/5m/1D OHLCV candles and plotting Buy/Sell arrows. |
| **4 - Hard** | **Multi-Leg F&O Strategy Basket Grouping** | 2–3 Weeks | Bundling 2–6 option legs + rolling adjustments into a single parent strategy with unified ROI%. |
| **4 - Hard** | **ITR-3 Tax Audit Turnover & 4-Bucket Export** | 2 Weeks | Calculating Section 44AB absolute F&O turnover, STCG/LTCG rules, and PAN-level splits. |
| **4 - Hard** | **MTF Interest & 50:50 Cash-Collateral Tracker** | 2–3 Weeks | Daily ledger math for Margin Trading Facility interest and pledged collateral haircuts. |
| **5 - Expert** | **MAE / MFE & Slippage Forensics (DuckDB)** | 3–4 Weeks | Requires high-resolution historical tick/1-minute `.parquet` data during the exact holding window of every trade. |
| **5 - Expert** | **Password-Protected Contract Note PDF Parser** | 3–4 Weeks | Local PDF table extraction across varying broker templates unlocked via PAN/DOB passwords. |
| **5 - Expert** | **Live WebSocket MTM & Auto Kill-Switch** | 4 Weeks | Persistent local WebSocket daemons monitoring live MTM loss and firing broker Kill-Switch APIs. |

---

## 8. Phase-Wise Execution Roadmap (v1.0 to v4.0)

### Phase 1: v1.0 MVP — "The Local-First Multi-Profile Ledger" (Months 1–2)
*Goal: Ship a zero-cloud local application with 1-click `.bhav` backups that replaces Excel and calculates Indian Net P&L accurately across multiple accounts.*
- **A. Local-First Storage & Backup Engine:**
  - Finalize OLTP database engine (SQLite/LibSQL in `STRICT` micro-rupee integer mode, $₹1 = 10^6$ micro-rupees) + local `/attachments` folder.
  - **1-Click Export Backup (`.bhav`)** to any local folder/USB drive and **1-Click Import/Restore**.
  - Optional AES-256 encryption for backup files and OS Keychain integration for broker API secrets.
- **B. Workspace & Profile Management:**
  - Create unlimited **Profiles** (`Intraday F&O`, `Swing Equity`, `Long-Term Investing`) and link multiple **Broker Accounts** to each.
  - Auto-route imported trades into profiles using `product_type` rules (`MIS` $\rightarrow$ Intraday, `CNC` held $> 1$ day $\rightarrow$ Swing).
- **C. Ingestion (Tier-1 CSV + Top 3 Local API Syncs):**
  - CSV Tradebook importers for **Zerodha Console, Dhan, Upstox, Groww, and Angel One**.
  - Direct local-to-broker API tradebook sync ("Sync Today's Bhav") for **Zerodha Kite, DhanHQ, and Upstox** (using a local loopback callback `http://127.0.0.1`).
  - Partial-fill aggregation engine (merging split order fills into single logical trades).
- **D. Exact Indian Tax & Brokerage Engine (`@bhavbook/core`):**
  - Automated calculation of Brokerage, STT/CTT, NSE/BSE Transaction Charges, SEBI Turnover Fees, IPFT, Stamp Duty, DP Charges, and 18% GST.
  - Gross P&L vs. Net P&L vs. "Cost of Overtrading" widgets.
- **E. Core Analytics & Journaling:**
  - Calendar Heatmap (Green/Red days, Net vs. Gross toggle).
  - Win Rate %, Profit Factor, Expectancy, Avg Winner/Loser, R-Multiple tracker.
  - Playbook tagger, Mistake tagger (`FOMO`, `Over-leveraged`, `Moved SL`), and clipboard screenshot paste.

### Phase 2: v2.0 — "Google Drive Sync & The Indian F&O Specialist" (Months 3–4)
*Goal: Enable seamless multi-device cloud backup via Google Drive and solve multi-leg options complexity.*
- **F. Google Drive Auto-Sync ("Bring Your Own Cloud"):**
  - 1-click Google Drive OAuth integration (`drive.appdata` scope).
  - Automated post-market `.bhav` backup upload and multi-device conflict detection (Desktop $\leftrightarrow$ Laptop sync).
- **G. Multi-Leg F&O Strategy Builder:**
  - Group individual CE/PE/FUT legs into named strategies (*Straddle, Iron Condor, Bull Call Spread*).
  - Track adjustment timelines (e.g., rolling strikes) inside the parent strategy.
  - Expiry-day (0DTE) auto-tagging and "Points Captured per Lot" normalization (accounting for historical NSE/BSE lot size changes).
- **H. Visual Execution & Charting:**
  - Integrate **TradingView Lightweight Charts** with free EOD/intraday OHLCV feeds to plot exact entry/exit arrows on underlying and option charts.
  - Scale-in / Scale-out pyramid tree visualizer for Swing Equity traders.
- **I. Expanded Broker API Coverage & Native Desktop Packaging:**
  - Add native API adapters for **Angel One SmartAPI, Fyers API v3, Shoonya (Finvasia), and Kotak Neo**.
  - Package app as a standalone **Tauri / Electron Desktop installer** (`.exe`, `.dmg`, `.AppImage`) with system tray reminders at 3:40 PM IST to sync trades before overnight broker flushes.

### Phase 3: v3.0 — "Tax Compliance, DuckDB OLAP & Quantitative Forensics" (Months 5–6)
*Goal: Become indispensable during tax season and provide institutional-grade execution forensics.*
- **J. Indian Tax & CA Audit Suite (ITR-3 Ready):**
  - **Section 44AB Tax Turnover Calculator:** Absolute sum of favorable and unfavorable F&O differences per PAN card.
  - **4-Bucket Income Segregation:** Speculative (Intraday Equity), Non-Speculative (F&O), STCG (20%), and LTCG (12.5%).
  - March **Tax-Loss Harvesting Scanner** for Swing/Investing profiles.
- **K. DuckDB OLAP, Margin, MTF & Slippage Intelligence:**
  - Introduce **DuckDB + `.parquet` candle store** for high-speed historical time-series queries.
  - MTF (Margin Trading Facility) daily interest deduction ledger for swing trades.
  - Slippage auditor comparing order trigger price vs. actual fill price.
  - MAE (Maximum Adverse Excursion) and MFE (Maximum Favorable Excursion) scatter plots.
- **L. Universal Contract Note PDF Parser:**
  - Local PDF parser (using PAN password locally) to ingest standardized SEBI/Exchange daily contract notes from any Indian broker.

### Phase 4: v4.0 — "Live Guardrails & Community Ecosystem" (Months 7+)
*Goal: Prevent blow-ups in real time and drive viral open-source adoption.*
- **M. Live WebSocket Risk & Kill-Switch Daemon:**
  - Real-time local MTM drawdown monitor across all connected brokers.
  - Automated **Kill-Switch trigger** (via Dhan/Zerodha APIs) when daily loss limits or max trade counts are breached.
- **N. "What-If" Counterfactual Simulator:**
  - Simulate equity curves under counterfactual rules (*"What if I stopped trading after 11:30 AM?"* or *"What if I capped daily loss at ₹5,000?"*).
- **O. Verified FinTwit PnL Cards & Local Webhook Bridges:**
  - Privacy-safe PnL share cards (showing ROI % or R-Multiple, hiding capital) and Chartink/TradingView alert ingestion.

---

## 9. Indian Broker API Directory & Technical Quirks

*Note for Local-First OAuth:* When users configure their own Broker API App in Zerodha/Upstox/Fyers, they set the Redirect URL to `http://127.0.0.1:4567/api/broker/callback`, allowing BhavBook to capture the `request_token` directly on their machine without any central relay server.

| Broker | Official Developer Portal / Docs URL | API Cost | Auth Mechanism | Key Technical Notes for Journal Ingestion |
| :--- | :--- | :--- | :--- | :--- |
| **Zerodha (Kite Connect)** | https://kite.trade/docs/connect/v3/ | **Free** (Personal order/portfolio APIs); ₹500/mo for Historical data | OAuth 2.0 + Daily `request_token` $\rightarrow$ `access_token` | `/orders` and `/trades` only return current day's executions. Historical trades require Console CSV export. |
| **Dhan (DhanHQ v2)** | https://docs.dhanhq.co/api/v2/ | **Free** (Trading + Data APIs) | `client_id` + `access-token` header (supports long-lived tokens & static IP) | Supports Historical Trade History API (`/v2/trades/{from-date}/{to-date}/{page}`) + native Kill Switch API. |
| **Upstox (API v2)** | https://upstox.com/developer/api-documentation/api-overview/ | **Free** | OAuth 2.0 Bearer Token + **Analytics Token** (1-year validity, read-only) | **Best for Local Journals:** Upstox's *Analytics Token* requires no daily login or OAuth redirect for read-only portfolio/order access. |
| **Angel One (SmartAPI)** | https://smartapi.angelbroking.com | **Free** | Client Code + MPIN + TOTP (via local `pyotp`/`otplib`) $\rightarrow$ JWT Token | 100% headless local auto-login via TOTP secret. Provides `getTradeBook` and `getOrderBook` endpoints. |
| **Fyers (API v3)** | https://myapi.fyers.in | **Free** | OAuth 2.0 `app_id` + `secret_key` $\rightarrow$ SHA256 hash | Clean JSON structure; free historical candle data for plotting trade executions locally. |
| **Shoonya (Finvasia)** | https://shoonya.com/api-documentation | **Free** | Bearer Token / `jData` payload over NorenOMS | Zero-brokerage favorite for option sellers. Note: Numeric values in JSON are returned as strings. |
| **ICICI Direct (Breeze)** | https://api.icicidirect.com | **Free** | Session Key + App Key | Strong historical F&O expired options OHLCV data (useful for reconstructing old option charts). |
| **Groww (Trade API)** | https://groww.in/trade-api | **Free** | OAuth / API Key | Rapidly growing retail user base; essential for CSV + API equity/F&O ingestion. |

---

## 10. Universal CSV / Excel Tradebook Schemas

### A. Canonical Target Schema (Internal Database)
Every CSV row or API payload normalizes into this structure:

```json
{
  "external_trade_id": "string",
  "external_order_id": "string",
  "execution_timestamp": "ISO-8601 UTC/IST",
  "exchange": "NSE | BSE | MCX",
  "segment": "EQ | FO | CDS | COM",
  "product_type": "INTRADAY | DELIVERY | MARGIN_MTF",
  "raw_symbol": "string",
  "underlying": "NIFTY | RELIANCE | ...",
  "instrument_type": "EQ | FUT | CE | PE",
  "expiry_date": "YYYY-MM-DD | null",
  "strike_price_micro": "Integer | null",
  "side": "BUY | SELL",
  "quantity": "Integer",
  "price_micro": "Integer"
}
```

### B. Broker-Specific CSV Header Mappings

#### 1. Zerodha Console (`tradebook-XXXX.csv`)
- **File Type:** `.csv` (UTF-8)
- **Columns:** `symbol`, `isin`, `trade_date`, `exchange`, `segment`, `series`, `trade_type`, `auction`, `quantity`, `price`, `trade_id`, `order_id`, `order_execution_time`, `expiry_date`
- **Parsing Quirks:**
  - `trade_type` uses lowercase `"buy"` / `"sell"`.
  - `segment` values are `EQ` (Equity), `FO` (Futures & Options), `CDS` (Currency), `COM` (Commodity).
  - Console CSV does **not** explicitly export the `product` (`MIS` vs `CNC`). **Workaround:** If `segment == 'EQ'` and buy/sell quantities net to zero on the same `trade_date`, classify as `INTRADAY` (`MIS`); otherwise classify as `DELIVERY` (`CNC`).

#### 2. Dhan Back-Office / Web (`Tradebook_XXXX.csv` / `.xlsx`)
- **File Type:** `.csv` or `.xlsx`
- **Columns:** `Date`, `Time`, `Exchange`, `Segment`, `Symbol`, `ISIN`, `Product`, `Buy/Sell`, `Quantity`, `Trade Price`, `Trade Value`, `Order ID`, `Trade ID`
- **Parsing Quirks:**
  - `Symbol` uses human-readable spaces for derivatives (e.g., `NIFTY 29 OCT 25000 CALL` instead of `NIFTY26OCT25000CE`). Requires a whitespace tokenizer to extract Underlying, Expiry, Strike, and Option Type.
  - `Product` explicitly states `INTRADAY`, `MARGIN`, or `CNC`.

#### 3. Upstox (`tradebook_XXXX.csv` / `.xlsx`)
- **File Type:** `.csv` or `.xlsx` (includes 4–6 metadata header rows at the top containing Client Name/ID before the table starts)
- **Columns:** `Date`, `Time`, `Scrip Name`, `Instrument`, `ISIN`, `Exchange`, `Segment`, `Buy/Sell`, `Quantity`, `Price`, `Amount`, `Order No`, `Trade No`, `Product`
- **Parsing Quirks:**
  - Parser must dynamically scan for the row starting with `Date` or `Scrip Name` to skip account summary rows at the top of the sheet.

#### 4. Angel One (`TradeHistory_XXXX.xlsx`)
- **File Type:** `.xlsx`
- **Columns:** `Trade Date`, `Exchange`, `Segment`, `Scrip Code`, `Symbol / Scrip Name`, `Trade Type`, `Quantity`, `Market Rate`, `Net Rate`, `Order No`, `Trade No`, `Trade Time`
- **Parsing Quirks:**
  - Includes both `Market Rate` (gross execution price) and `Net Rate` (brokerage-adjusted price). Always ingest `Market Rate` and compute taxes/brokerage via the internal rule engine to avoid double-counting brokerage.

#### 5. Groww (`Stocks_Order_History.xlsx` / `FnO_Tradebook.csv`)
- **File Type:** `.xlsx` / `.csv` (Groww separates Stocks and F&O reports)
- **Columns:** `Stock Name`, `Symbol`, `ISIN`, `Type` (`Buy`/`Sell`), `Quantity`, `Price`, `Exchange`, `Order ID`, `Execution Date & Time`, `Order Status`
- **Parsing Quirks:**
  - Filter strictly for `Order Status == "Executed"` (some Groww exports include rejected/cancelled orders).

---

## 11. Indian Statutory Tax & Charges Reference Matrix (FY 2026–27)

Every trade ingested passes through BhavBook's deterministic local fee calculator using this exact matrix:

| Charge Component | Equity Delivery (`CNC`) | Equity Intraday (`MIS`) | F&O Futures | F&O Options |
| :--- | :--- | :--- | :--- | :--- |
| **Brokerage (Discount Broker Default)** | ₹0 or ₹20 / $0.1\%$ | ₹20 or $0.03\%$ (whichever is lower) | ₹20 or $0.03\%$ (whichever is lower) | Flat ₹20 per executed order |
| **STT (Securities Transaction Tax)** | **$0.1\%$** on Buy & Sell | **$0.025\%$** on Sell side only | **$0.02\%$** on Sell side only | **$0.1\%$** on Sell side (on premium) |
| **Exchange Txn Charges (NSE)** | **$0.00297\%$** | **$0.00297\%$** | **$0.00173\%$** | **$0.03503\%$** (on premium) |
| **SEBI Turnover Charges** | ₹10 per Crore ($0.0001\%$) | ₹10 per Crore ($0.0001\%$) | ₹10 per Crore ($0.0001\%$) | ₹10 per Crore ($0.0001\%$) |
| **IPFT (NSE Investor Protection)** | ₹10 per Crore ($0.0001\%$) | ₹10 per Crore ($0.0001\%$) | ₹10 per Crore ($0.0001\%$) | ₹50 per Crore ($0.0005\%$ on premium) |
| **Stamp Duty (Buy Side Only)** | **$0.015\%$** on Buy | **$0.003\%$** on Buy | **$0.002\%$** on Buy | **$0.003\%$** on Buy |
| **GST** | **$18\%$** on (Brokerage + Exchange Txn + SEBI + IPFT) | **$18\%$** on (Brokerage + Exchange Txn + SEBI + IPFT) | **$18\%$** on (Brokerage + Exchange Txn + SEBI + IPFT) | **$18\%$** on (Brokerage + Exchange Txn + SEBI + IPFT) |
| **DP Charges (Sell Side Only)** | ₹13.5 to ₹15.93 + $18\%$ GST per scrip per day | ₹0 | ₹0 | ₹0 |