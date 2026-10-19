-- CLAIM-008: contractors claim as non-employees, and finance marks expenses it treats as non-accountable (taxable).
ALTER TABLE c_members ADD COLUMN is_contractor INTEGER NOT NULL DEFAULT 0 CHECK (is_contractor IN (0, 1));
CREATE TABLE c_nonaccountable (
  item_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  marked_by TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX c_nonaccountable_claim ON c_nonaccountable(claim_id);
