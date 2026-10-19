-- 0002_batch_row: each import batch's own copy of every row it contained (plan r5).
-- trade_row / statement_row keep one row per dedup key, owned by the first batch that brought it. batch_row keeps
-- every batch's canonical row, deduplicated or not, so undoing a batch can re-insert rows another batch shares
-- (S7-2) without re-parsing files. Payloads are the adapter's canonical JSON: no names, IDs or file metadata.

CREATE TABLE batch_row (
  id INTEGER PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batch (id) ON DELETE CASCADE,
  target TEXT NOT NULL CHECK (target IN ('trade', 'statement')),
  -- The statement kind; '' for trade rows.
  kind TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (batch_id, target, kind, dedup_key)
) STRICT;

CREATE INDEX batch_row_key ON batch_row (target, kind, dedup_key);
