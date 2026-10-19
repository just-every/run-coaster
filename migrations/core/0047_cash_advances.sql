-- CLAIM-004: cash advances. An employee requests an advance, their routed approver decides it, finance records it paid
-- (outside Coaster until PAY-001), one later claim draws it down and finance records any excess returned.
CREATE TABLE c_advances (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  employee_email TEXT NOT NULL,
  approver_email TEXT NOT NULL,
  on_behalf_of TEXT,
  purpose TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  status TEXT NOT NULL CHECK (status IN ('submitted', 'approved', 'rejected', 'paid')),
  version INTEGER NOT NULL DEFAULT 1,
  submitted_by TEXT NOT NULL,
  decided_by TEXT,
  decided_on_behalf_of TEXT,
  decided_at TEXT,
  reason TEXT NOT NULL DEFAULT '',
  paid_by TEXT,
  paid_on TEXT,
  paid_reference TEXT,
  claim_id TEXT UNIQUE,
  -- What a settling claim drew down, kept when RETAIN-001 later removes that claim.
  kept_applied_minor INTEGER NOT NULL DEFAULT 0,
  returned_minor INTEGER NOT NULL DEFAULT 0 CHECK (returned_minor >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (approver_email <> employee_email)
);
CREATE INDEX c_advances_employee ON c_advances(employee_email);
-- Each excess return finance records against an advance.
CREATE TABLE c_advance_returns (
  id TEXT PRIMARY KEY,
  advance_id TEXT NOT NULL REFERENCES c_advances(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  returned_on TEXT NOT NULL,
  reference TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX c_advance_returns_advance ON c_advance_returns(advance_id);
-- The ledger account the "advance applied" accounting line posts to.
ALTER TABLE c_business ADD COLUMN advance_account TEXT NOT NULL DEFAULT '';
