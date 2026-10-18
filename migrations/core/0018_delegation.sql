-- Delegation, out of office and reassignment (APPROVE-002). An approver hands
-- their approvals to a named colleague for a date range; a claim submitted in
-- that range routes to the delegate and records whose approval it acts for.
CREATE TABLE c_delegations (
  id TEXT PRIMARY KEY,
  approver_email TEXT NOT NULL,
  delegate_email TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_by TEXT,
  revoked_at TEXT,
  CHECK (delegate_email <> approver_email),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX c_delegations_approver ON c_delegations(approver_email, starts_on);
ALTER TABLE c_claims ADD COLUMN on_behalf_of TEXT;
ALTER TABLE c_decisions ADD COLUMN on_behalf_of TEXT;
