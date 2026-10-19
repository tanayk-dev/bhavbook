# BhavBook Domain Rules

> These rules are specific to BhavBook. They come from `docs/product/PRD.md` and the ADRs in `docs/adr/`; the original spec in `docs/product/reference/` is background only. Where they conflict with `ecc/` rules, these take precedence. To change a rule, write a new ADR.

## Money (CRITICAL)

Every monetary value — prices, strikes, brokerage, taxes, P&L, margins, interest — is an integer count of **micro-rupees**.

- `1 Rupee = 1,000,000 micro-rupees`, `1 Paisa = 10,000 micro-rupees`
- Database: 64-bit `INTEGER` columns in `STRICT` tables, named with a `_micro` suffix (`price_micro`, `strike_price_micro`, `stt_micro`)
- NEVER use `REAL`, JS `number` floats, `parseFloat`, or `toFixed` for money math
- Round to 2-decimal paisa only at the UI display layer, through one shared formatting helper. Never round computed values in storage. Two exceptions:
  - the fee engine applies the **broker's billing rounding** at the unit where the broker bills (ADR-0016);
  - adapters may apply a **declared normalisation** to the broker's known precision (ADR-0010)
- Percentage rates (e.g. `0.00297%`) live in the fee-rule JSON as decimal strings. They are evaluated as bigint rationals with explicit rounding modes, never as floats (ADR-0004)

### Overflow

- JS `Number.MAX_SAFE_INTEGER` is only about ₹900 crore in micro-rupees. Aggregates (annual F&O turnover, notional value) and `amount × rate` intermediates can exceed it
- In TypeScript, do money arithmetic in `bigint` (rates as bigint rationals; no decimal library) and read SQLite with `better-sqlite3` `safeIntegers` enabled
- In Rust, use `i64` with checked arithmetic (`checked_mul`, `checked_add`) or `i128` for intermediates

### Ingestion

- Convert broker prices (strings or floats in CSV/JSON) to micro-rupees by parsing the decimal string directly. Never go through a float
- Always keep the raw string next to the normalised value. Zerodha equity prices are float32 artefacts (`700.599976`), so round them half-up to 0.01 as a string operation (ADR-0010)
- Every row stores `trade_value_micro` and `value_authority`. For Dhan, `Trade Value` is authoritative and the price is derived from it (ADR-0008)
- Angel One: ingest `Market Rate`, never `Net Rate`. Fee estimates come from the internal engine; broker statements override them when imported (ADR-0017)

## Time

- Store `execution_timestamp` in UTC (ISO-8601)
- Use `Asia/Kolkata` (IST) for display and for all session logic: 3:40 PM sync, the 12:00–6:00 AM broker flush window, trading-day boundaries, expiry-day (0DTE) detection, and the "CNC held > 1 day" routing rule
- Never use the machine's local timezone for market logic

## Profile Isolation

- Every trade query, FIFO match, and analytics aggregation is scoped by `profile_id`
- FIFO matching never crosses product types (`INTRADAY` / `DELIVERY` / `MARGIN_MTF`), accounts or profiles. The key is (account, ISIN, bucket): **exchange is not part of it**, because NSE buys can close on BSE (ADR-0011). Each account belongs to exactly one profile
- Same-day netting defines intraday for every broker: `min(bought, sold)` per (account, ISIN, IST date), matched in time order, whatever product was declared (ADR-0012)
- Holdings never go negative. An orphan sell marks the position INCOMPLETE; fixes are revertible adjustment records, never edits to imported rows (ADR-0007, ADR-0013)
- Tax buckets (Speculative, Non-Speculative F&O, STCG, LTCG) and Section 44AB turnover aggregate per PAN entity

## Fee & Tax Engine (`@bhavbook/core`)

- The engine is deterministic and pure: same trade + same rule file = same result
- Fee rules are JSON files versioned by financial year and effective date. Pick the rule version from the trade date, never "latest"
- Lot sizes are time-versioned the same way
- Each charge is computed at the unit the broker bills: brokerage per executed order; STT and stamp duty per contract note (account + IST date + exchange), rounded half-up to the rupee; then allocated to fills by value using largest remainder (ADR-0016)
- Every charge component (brokerage, STT/CTT, exchange txn, SEBI, IPFT, stamp duty, GST, DP) has golden-value tests checked to the exact micro-rupee. Every rule version also passes against the broker statements we hold for its period
- GST applies to brokerage + exchange txn + SEBI + IPFT only, never to STT or stamp duty

## Broker Ingestion

- Each broker parser has fixture-based tests using a real-format sample file (anonymised: no real PAN, client ID, or names)
- Adapters are pure (bytes in, data out; no I/O or DB)
- Re-imports are idempotent: `UNIQUE(broker_account_id, dedup_key)` with a per-adapter key (ADR-0009):
  - Zerodha: `zerodha:{exchange}:{trade_date}:{order_id}:{trade_id}`
  - Dhan: a content hash plus an occurrence index
- Parsers handle documented quirks: Upstox metadata header rows, Dhan human-readable derivative symbols, Groww non-executed rows, Zerodha missing product column, and Journal CSV metadata and footer blocks (see `docs/broker-exports/*/NOTES.md`)
- Canonical rows are fill-or-order (`granularity`). Fills group into orders only where `granularity = fill`. Raw rows are always kept
- No bundled security master. ISINs are resolved from the row, then a transaction join with imported statements, then aliases, then manual mapping (ADR-0014)

## Credentials & Privacy

- Broker secrets (`api_secret`, `access_token`, `totp_key`) are stored only via AES-256-GCM with an Argon2id-derived key, or in the OS keychain. Never in plaintext, `config.json`, or logs
- Never log PAN, client IDs, tokens, or passwords. Treat contract-note PDF passwords (PAN/DOB) as secrets
- Never **store** a name, PAN, client ID (hashed or not), mobile, email, original file name or file metadata block. Imports keep only the file SHA-256, report kind and coverage (ADR-0019)
- Every local HTTP and WebSocket route requires the session token and passes the Host/Origin allowlist (ADR-0002)
- No telemetry, analytics, or calls to any BhavBook-operated server. The app has no central backend
- OAuth callback listeners bind to `127.0.0.1` only, never `0.0.0.0`
- Google Drive uses only the `drive.appdata` (or single-folder) scope

## Backup & Migrations

- `.bhav` snapshots use a transactionally consistent copy (`VACUUM INTO`), never a raw file copy of a live database
- Restore verifies the SHA-256 checksum before touching the live vault
- Schema migrations are forward-only, numbered, and tested by restoring an older-version backup fixture
