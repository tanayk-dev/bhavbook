-- 0005_journal_attachment: which position each journal entry is attached to (S10c, ADR-0018). Derived state:
-- recompute deletes an account's positions (which cascades here) and re-attaches every entry to the position that
-- now contains its anchor fill. The entry itself is user data and is never deleted by a recompute.

CREATE TABLE journal_attachment (
  journal_entry_id TEXT PRIMARY KEY REFERENCES journal_entry (id) ON DELETE CASCADE,
  position_id TEXT NOT NULL REFERENCES position (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX journal_attachment_position ON journal_attachment (position_id);
