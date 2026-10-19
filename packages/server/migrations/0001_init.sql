-- 0001_init: BhavBook vault schema v1 (PRD §10, ADR-0003, ADR-0019).
-- Rules: every table STRICT; money is *_micro INTEGER (micro-rupees); timestamps are UTC ISO-8601 TEXT;
-- IST calendar dates are 'YYYY-MM-DD' TEXT; no column stores a name, PAN, client ID, mobile, email or file name.
-- Forward-only: never edit this file once released; add 0002_*.sql instead.
-- Value sets that may grow (brokers, batch states, issue kinds) are validated in application code, not CHECKs,
-- so adding one never forces a table rebuild.

-- Marks the file as a BhavBook vault ('BHAV'); restore refuses any other SQLite file.
PRAGMA application_id = 1112031574;

-- Ownership hierarchy ----------------------------------------------------------------------------------------

CREATE TABLE pan_entity (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE profile (
  id TEXT PRIMARY KEY,
  pan_entity_id TEXT NOT NULL REFERENCES pan_entity (id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (pan_entity_id, name)
) STRICT;

CREATE TABLE broker_account (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profile (id),
  broker TEXT NOT NULL,
  nickname TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- Imports (raw data is immutable, ADR-0007) ------------------------------------------------------------------

CREATE TABLE import_batch (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES broker_account (id) ON DELETE CASCADE,
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  report_kind TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  coverage_from TEXT,
  coverage_to TEXT,
  counts_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX import_batch_account ON import_batch (account_id, report_kind);

CREATE TABLE raw_row (
  id INTEGER PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batch (id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  raw_text TEXT NOT NULL,
  UNIQUE (batch_id, line_no)
) STRICT;

CREATE TABLE trade_row (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES broker_account (id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES import_batch (id) ON DELETE CASCADE,
  raw_row_id INTEGER REFERENCES raw_row (id) ON DELETE CASCADE,
  dedup_key TEXT NOT NULL,
  granularity TEXT NOT NULL CHECK (granularity IN ('fill', 'order')),
  source TEXT NOT NULL CHECK (source IN ('tradebook', 'external')),
  external_order_id TEXT,
  executed_at_utc TEXT NOT NULL,
  trade_date_ist TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price_micro INTEGER NOT NULL CHECK (price_micro >= 0),
  trade_value_micro INTEGER NOT NULL CHECK (trade_value_micro >= 0),
  value_authority TEXT NOT NULL CHECK (value_authority IN ('price', 'value')),
  exchange TEXT NOT NULL CHECK (exchange IN ('NSE', 'BSE')),
  isin TEXT CHECK (isin IS NULL OR length(isin) = 12),
  broker_symbol TEXT,
  broker_name TEXT,
  product_declared TEXT CHECK (product_declared IS NULL OR product_declared IN ('DELIVERY', 'INTRADAY', 'MTF')),
  flags_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (account_id, dedup_key)
) STRICT;

CREATE INDEX trade_row_account_date ON trade_row (account_id, trade_date_ist);
CREATE INDEX trade_row_batch ON trade_row (batch_id);
CREATE INDEX trade_row_raw ON trade_row (raw_row_id);

CREATE TABLE statement_row (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES broker_account (id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES import_batch (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  key_json TEXT NOT NULL,
  data_json TEXT NOT NULL,
  UNIQUE (account_id, kind, dedup_key)
) STRICT;

CREATE INDEX statement_row_batch ON statement_row (batch_id);

-- Instruments ------------------------------------------------------------------------------------------------

CREATE TABLE instrument (
  id TEXT PRIMARY KEY,
  isin TEXT UNIQUE CHECK (isin IS NULL OR length(isin) = 12),
  display_name TEXT NOT NULL
) STRICT;

CREATE TABLE instrument_alias (
  id TEXT PRIMARY KEY,
  broker TEXT NOT NULL,
  alias TEXT NOT NULL,
  instrument_id TEXT NOT NULL REFERENCES instrument (id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('file', 'join', 'learned', 'manual')),
  created_at TEXT NOT NULL,
  UNIQUE (broker, alias)
) STRICT;

-- User-entered facts (revertible, never edits imported rows) -------------------------------------------------

CREATE TABLE corporate_action (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('SPLIT', 'BONUS', 'CONVERSION', 'DEMERGER')),
  isin TEXT NOT NULL CHECK (length(isin) = 12),
  new_isin TEXT CHECK (new_isin IS NULL OR length(new_isin) = 12),
  ex_date TEXT NOT NULL,
  -- Bonus lots are dated at allotment (s.55(2)(aa)); defaults to the ex-date when unknown.
  allotment_date TEXT,
  ratio_num INTEGER NOT NULL CHECK (ratio_num > 0),
  ratio_den INTEGER NOT NULL CHECK (ratio_den > 0),
  cost_split_bp INTEGER CHECK (cost_split_bp IS NULL OR cost_split_bp BETWEEN 0 AND 10000),
  status TEXT NOT NULL CHECK (status IN ('active', 'reverted')),
  created_at TEXT NOT NULL,
  CHECK (type NOT IN ('CONVERSION', 'DEMERGER') OR new_isin IS NOT NULL),
  CHECK (type <> 'DEMERGER' OR cost_split_bp IS NOT NULL)
) STRICT;

-- User data: deleting an account must not silently remove it (RESTRICT).
CREATE TABLE adjustment (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES broker_account (id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('opening_lot', 'exclude', 'product_override')),
  payload_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'broker_statement')),
  status TEXT NOT NULL CHECK (status IN ('active', 'reverted', 'superseded')),
  superseded_by TEXT REFERENCES adjustment (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX adjustment_account ON adjustment (account_id, status);

-- Journal (anchored to the opening entry, ADR-0018) ----------------------------------------------------------

CREATE TABLE tag (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('setup', 'mistake')),
  name TEXT NOT NULL,
  UNIQUE (kind, name)
) STRICT;

-- Journal entries are never deleted by the system (PRD §10.1): RESTRICT on account deletion. Re-attachment after a
-- recompute matches on (anchor_account_id, anchor_key); anchor_instrument_key is refreshed when instruments re-key.
CREATE TABLE journal_entry (
  id TEXT PRIMARY KEY,
  anchor_account_id TEXT NOT NULL REFERENCES broker_account (id) ON DELETE RESTRICT,
  anchor_instrument_key TEXT NOT NULL,
  anchor_bucket TEXT NOT NULL CHECK (anchor_bucket IN ('DELIVERY', 'INTRADAY', 'MTF')),
  anchor_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('attached', 'unattached')),
  setup_tag_id TEXT REFERENCES tag (id) ON DELETE SET NULL,
  thesis TEXT,
  initial_stop_micro INTEGER,
  planned_stop_micro INTEGER,
  planned_target_micro INTEGER,
  planned_risk_micro INTEGER CHECK (planned_risk_micro IS NULL OR planned_risk_micro > 0),
  review_note TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX journal_entry_anchor ON journal_entry (anchor_account_id, anchor_key);
CREATE INDEX journal_entry_setup_tag ON journal_entry (setup_tag_id);

CREATE TABLE journal_tag (
  journal_entry_id TEXT NOT NULL REFERENCES journal_entry (id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tag (id) ON DELETE CASCADE,
  PRIMARY KEY (journal_entry_id, tag_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX journal_tag_tag ON journal_tag (tag_id);

CREATE TABLE attachment (
  id TEXT PRIMARY KEY,
  journal_entry_id TEXT NOT NULL REFERENCES journal_entry (id) ON DELETE CASCADE,
  mime TEXT NOT NULL CHECK (mime = 'image/webp'),
  data BLOB NOT NULL CHECK (length(data) <= 1048576),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX attachment_journal_entry ON attachment (journal_entry_id);

-- Settings and issues ----------------------------------------------------------------------------------------

CREATE TABLE setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- `fingerprint` identifies the subject of an issue, so a recompute updates it instead of duplicating it and a
-- dismissed issue stays dismissed.
CREATE TABLE issue (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES broker_account (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  subject_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE UNIQUE INDEX issue_identity ON issue (ifnull(account_id, ''), kind, fingerprint);
CREATE INDEX issue_status ON issue (status, kind);

-- Derived state: rebuilt by recompute, never edited by hand (ADR-0007) ----------------------------------------
-- Recompute deletes children before parents (charges, reconciliation, lots, positions, allocations), and every
-- cascading child column is indexed so deletes stay linear.

CREATE TABLE fill_allocation (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES broker_account (id) ON DELETE CASCADE,
  trade_row_id INTEGER REFERENCES trade_row (id) ON DELETE CASCADE,
  adjustment_id TEXT REFERENCES adjustment (id) ON DELETE CASCADE,
  -- Lots created by a bonus, conversion or demerger (S10b) have no trade or adjustment behind them.
  corporate_action_id TEXT REFERENCES corporate_action (id) ON DELETE CASCADE,
  instrument_key TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('DELIVERY', 'INTRADAY', 'MTF')),
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  value_micro INTEGER NOT NULL CHECK (value_micro >= 0),
  inferred INTEGER NOT NULL CHECK (inferred IN (0, 1)),
  CHECK ((trade_row_id IS NOT NULL) + (adjustment_id IS NOT NULL) + (corporate_action_id IS NOT NULL) = 1)
) STRICT;

CREATE INDEX fill_allocation_key ON fill_allocation (account_id, instrument_key, bucket);
CREATE INDEX fill_allocation_trade_row ON fill_allocation (trade_row_id);
CREATE INDEX fill_allocation_adjustment ON fill_allocation (adjustment_id);
CREATE INDEX fill_allocation_corporate_action ON fill_allocation (corporate_action_id);

-- `id` is derived deterministically from (account, instrument, bucket, anchor) so a recompute is byte-identical.
CREATE TABLE position (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES broker_account (id) ON DELETE CASCADE,
  instrument_key TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('DELIVERY', 'INTRADAY', 'MTF')),
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'CLOSED')),
  incomplete INTEGER NOT NULL CHECK (incomplete IN (0, 1)),
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  orphan_qty INTEGER NOT NULL DEFAULT 0 CHECK (orphan_qty >= 0),
  opened_at_utc TEXT NOT NULL,
  closed_at_utc TEXT,
  anchor_key TEXT NOT NULL,
  UNIQUE (account_id, instrument_key, bucket, anchor_key)
) STRICT;

CREATE INDEX position_account ON position (account_id, state);

CREATE TABLE lot (
  id INTEGER PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES position (id) ON DELETE CASCADE,
  entry_allocation_id INTEGER NOT NULL REFERENCES fill_allocation (id) ON DELETE CASCADE,
  exit_allocation_id INTEGER REFERENCES fill_allocation (id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  entry_value_micro INTEGER NOT NULL CHECK (entry_value_micro >= 0),
  exit_value_micro INTEGER CHECK (exit_value_micro IS NULL OR exit_value_micro >= 0),
  entry_date_ist TEXT NOT NULL,
  exit_date_ist TEXT,
  CHECK ((exit_allocation_id IS NULL) = (exit_value_micro IS NULL) AND (exit_value_micro IS NULL) = (exit_date_ist IS NULL))
) STRICT;

CREATE INDEX lot_position ON lot (position_id);
CREATE INDEX lot_entry_allocation ON lot (entry_allocation_id);
CREATE INDEX lot_exit_allocation ON lot (exit_allocation_id);

CREATE TABLE fill_charge (
  id INTEGER PRIMARY KEY,
  fill_allocation_id INTEGER NOT NULL REFERENCES fill_allocation (id) ON DELETE CASCADE,
  component TEXT NOT NULL CHECK (component IN ('brokerage', 'stt', 'exchange_txn', 'sebi', 'ipft', 'stamp_duty', 'gst', 'dp')),
  amount_micro INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('estimated', 'reported')),
  rule_version TEXT,
  UNIQUE (fill_allocation_id, component, source)
) STRICT;

CREATE TABLE charge_reconciliation (
  id INTEGER PRIMARY KEY,
  position_id TEXT NOT NULL UNIQUE REFERENCES position (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('FEES_ESTIMATED', 'FEES_RECONCILED', 'FEES_DISCREPANCY')),
  diff_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
