-- Spend requests and trip pre-approval (CLAIM-005). An employee asks before
-- spending with an estimate; the request routes like a claim and expenses link
-- to it so approvers see estimate against actual. Above the owner's threshold an
-- expense without an approved request is a policy exception.
CREATE TABLE c_requests (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  employee_email TEXT NOT NULL,
  approver_email TEXT NOT NULL,
  on_behalf_of TEXT,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  estimate_minor INTEGER NOT NULL CHECK (estimate_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  status TEXT NOT NULL CHECK (status IN ('submitted', 'approved', 'rejected')),
  version INTEGER NOT NULL DEFAULT 1,
  submitted_by TEXT NOT NULL,
  decided_by TEXT,
  decided_on_behalf_of TEXT,
  decided_at TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (approver_email <> employee_email)
);
ALTER TABLE c_items ADD COLUMN request_id TEXT REFERENCES c_requests(id);
CREATE INDEX c_items_request ON c_items(request_id);
ALTER TABLE c_business ADD COLUMN preapproval_threshold_minor INTEGER CHECK (preapproval_threshold_minor IS NULL OR preapproval_threshold_minor >= 0);
