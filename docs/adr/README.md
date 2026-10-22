# Architecture Decision Records

Decisions for BhavBook. The product context is in [`../product/PRD.md`](../product/PRD.md), and the evidence is in [`../product/research/`](../product/research/).

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](0001-local-first-npx-web-app.md) | Local-first single-user app served by `npx bhavbook` on 127.0.0.1 | accepted | 2026-10-19 |
| [0002](0002-localhost-request-security.md) | Session token plus Host/Origin allowlist for the local server | accepted | 2026-10-19 |
| [0003](0003-sqlite-better-sqlite3-strict.md) | SQLite `STRICT` tables through better-sqlite3; DuckDB deferred | accepted | 2026-10-19 |
| [0004](0004-money-bigint-micro-rupees.md) | Money as bigint micro-rupees; rates as bigint rationals; no decimal library | accepted | 2026-10-19 |
| [0005](0005-time-utc-storage-ist-logic.md) | Store UTC; compute all market logic in Asia/Kolkata | accepted | 2026-10-19 |
| [0006](0006-file-import-only-v1.md) | v1 ingests broker files only: no APIs, no stored credentials | accepted | 2026-10-19 |
| [0007](0007-immutable-raw-derived-state.md) | Imported rows are immutable; everything else is derived by a pure recompute | accepted | 2026-10-19 |
| [0008](0008-broker-adapter-contract.md) | Pure broker adapters producing canonical fill-or-order rows | accepted | 2026-10-19 |
| [0009](0009-per-adapter-dedup-keys.md) | Per-adapter dedup keys with UNIQUE(account, dedup_key) | accepted | 2026-10-19 |
| [0010](0010-per-adapter-price-normalisation.md) | Declared per-adapter price normalisation, keeping the raw string | accepted | 2026-10-19 |
| [0011](0011-fifo-scope-and-profiles.md) | FIFO per (account, ISIN, product bucket); exchange excluded; one profile per account | accepted | 2026-10-19 |
| [0012](0012-same-day-netting-intraday.md) | Same-day netting defines intraday for every broker and product | accepted | 2026-10-19 |
| [0013](0013-incomplete-history-adjustments.md) | Incomplete history: INCOMPLETE flag plus opening-lot adjustments, including from broker statements | accepted | 2026-10-19 |
| [0014](0014-instrument-resolution-no-bundled-master.md) | Resolve ISINs by transaction join; no bundled security master | accepted | 2026-10-19 |
| [0015](0015-manual-corporate-actions.md) | Manual corporate actions with tax-faithful lot rules | accepted | 2026-10-19 |
| [0016](0016-fee-engine-contract-note.md) | Date-versioned fee rules computed per contract note, with golden tests | accepted | 2026-10-19 |
| [0017](0017-hybrid-costs-reconciliation.md) | Hybrid costs: engine estimates, broker statements win | accepted | 2026-10-19 |
| [0018](0018-journal-anchoring.md) | Journal entries anchor to the position's opening entry, not to a position ID | accepted | 2026-10-19 |
| [0019](0019-privacy-no-client-identifiers.md) | Store no client identifiers, file names or metadata blocks | accepted | 2026-10-19 |
| [0020](0020-backup-and-migrations.md) | Single-file .bhav backups, BLOB screenshots, forward-only migrations | accepted | 2026-10-19 |
| [0021](0021-tech-stack-and-versions.md) | TypeScript monorepo stack, pinned to the latest stable versions (2026-10-19) | accepted | 2026-10-19 |
| [0022](0022-charts-evilcharts-echarts.md) | Charts: EvilCharts components on the ECharts engine | accepted | 2026-10-19 |
| [0023](0023-spreadsheet-parsing-sheetjs.md) | Parse XLSX/XLS with SheetJS CE 0.20.3 from the official CDN, in a worker | accepted | 2026-10-19 |
| [0024](0024-testing-strategy-golden-fixtures.md) | Golden fixtures from scrubbed real exports, plus property tests | accepted | 2026-10-19 |
| [0025](0025-analytics-definitions.md) | Analytics units and R-multiple definition | accepted | 2026-10-19 |
| [0026](0026-license-mit.md) | MIT licence | accepted | 2026-10-19 |
| [0027](0027-initial-stop-fill-once-after-close.md) | An empty initial stop can be filled in once after the close | accepted | 2026-10-22 |
| [0028](0028-dashboard-charts-on-echarts.md) | Dashboard charts drawn with ECharts on EvilCharts' base | accepted | 2026-10-22 |
