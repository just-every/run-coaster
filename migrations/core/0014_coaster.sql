-- Coaster: one business, its people, claims with receipt bytes, decisions,
-- reimbursement batches, agent proposals and imported history.
-- Money is integer minor units of the one business currency.

CREATE TABLE c_business (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  timezone TEXT NOT NULL,
  mileage_rate_minor INTEGER NOT NULL CHECK (mileage_rate_minor >= 0),
  per_diem_minor INTEGER NOT NULL DEFAULT 0 CHECK (per_diem_minor >= 0),
  receipt_threshold_minor INTEGER NOT NULL DEFAULT 0 CHECK (receipt_threshold_minor >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE c_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  account_code TEXT NOT NULL,
  tax_code TEXT NOT NULL,
  limit_minor INTEGER CHECK (limit_minor IS NULL OR limit_minor >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- Coaster roles belong to people by email; native sign-in proves who they are.
CREATE TABLE c_members (
  email TEXT PRIMARY KEY CHECK (email = lower(email)),
  name TEXT NOT NULL,
  is_employee INTEGER NOT NULL CHECK (is_employee IN (0, 1)),
  is_manager INTEGER NOT NULL CHECK (is_manager IN (0, 1)),
  is_finance INTEGER NOT NULL CHECK (is_finance IN (0, 1)),
  approver_email TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL,
  CHECK (approver_email IS NULL OR approver_email <> email)
);

CREATE TABLE c_receipts (
  id TEXT PRIMARY KEY,
  claim_id TEXT REFERENCES c_claims(id),
  proposal_id TEXT REFERENCES c_proposals(id),
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  bytes BLOB NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('upload', 'camera', 'agent')),
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  CHECK (length(bytes) = size)
);
CREATE INDEX c_receipts_claim ON c_receipts(claim_id);
CREATE INDEX c_receipts_hash ON c_receipts(sha256);
CREATE TRIGGER c_receipts_keep_bytes BEFORE UPDATE OF bytes, sha256, size, name, uploaded_by, uploaded_at ON c_receipts
BEGIN SELECT RAISE(ABORT, 'receipt evidence is permanent'); END;
CREATE TRIGGER c_receipts_no_delete BEFORE DELETE ON c_receipts
BEGIN SELECT RAISE(ABORT, 'receipt evidence is permanent'); END;

CREATE TABLE c_claims (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  employee_email TEXT NOT NULL,
  approver_email TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'returned', 'approved', 'rejected', 'batched', 'reimbursed')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  version INTEGER NOT NULL DEFAULT 1,
  total_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  currency TEXT NOT NULL,
  prepared_by TEXT,
  batch_id TEXT REFERENCES c_batches(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX c_claims_employee ON c_claims(employee_email);
CREATE INDEX c_claims_approver ON c_claims(approver_email);

CREATE TABLE c_items (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES c_claims(id),
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('receipt', 'mileage', 'per_diem')),
  spent_on TEXT NOT NULL,
  merchant TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  distance_hundredths INTEGER CHECK (distance_hundredths IS NULL OR distance_hundredths > 0),
  days INTEGER CHECK (days IS NULL OR days > 0),
  rate_minor INTEGER CHECK (rate_minor IS NULL OR rate_minor > 0),
  receipt_id TEXT REFERENCES c_receipts(id),
  explanation TEXT NOT NULL DEFAULT ''
);
CREATE INDEX c_items_claim ON c_items(claim_id, position);

CREATE TABLE c_allocations (
  item_id TEXT NOT NULL REFERENCES c_items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  category_id TEXT NOT NULL REFERENCES c_categories(id),
  cost_centre TEXT NOT NULL DEFAULT '',
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (item_id, position)
);

-- Each submission freezes the exact claim: items, allocations, receipt links
-- and the exceptions found. Revisions and decisions are never rewritten.
CREATE TABLE c_revisions (
  claim_id TEXT NOT NULL REFERENCES c_claims(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  submitted_by TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  total_minor INTEGER NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  PRIMARY KEY (claim_id, revision)
);
CREATE TRIGGER c_revisions_append_only BEFORE UPDATE ON c_revisions BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
CREATE TRIGGER c_revisions_no_delete BEFORE DELETE ON c_revisions BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;

CREATE TABLE c_decisions (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'returned', 'rejected')),
  reason TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  at TEXT NOT NULL,
  exceptions TEXT NOT NULL CHECK (json_valid(exceptions)),
  FOREIGN KEY (claim_id, revision) REFERENCES c_revisions(claim_id, revision),
  UNIQUE (claim_id, revision)
);
CREATE TRIGGER c_decisions_append_only BEFORE UPDATE ON c_decisions BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
CREATE TRIGGER c_decisions_no_delete BEFORE DELETE ON c_decisions BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;

CREATE TABLE c_batches (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'reimbursed')),
  currency TEXT NOT NULL,
  total_minor INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  prepared_by TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  paid_reference TEXT,
  paid_on TEXT,
  paid_by TEXT
);

CREATE TABLE c_batch_claims (
  batch_id TEXT NOT NULL REFERENCES c_batches(id),
  claim_id TEXT NOT NULL UNIQUE REFERENCES c_claims(id),
  revision INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL,
  PRIMARY KEY (batch_id, claim_id)
);

-- One exact expense reimburses once: the receipt bytes' SHA-256, or for an
-- expense without a receipt its employee, date, kind, merchant and amount.
CREATE TABLE c_reimbursement_keys (
  key TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES c_batches(id),
  claim_id TEXT NOT NULL REFERENCES c_claims(id),
  item_id TEXT NOT NULL
);

CREATE TABLE c_events (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  at TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  claim_id TEXT,
  batch_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail))
);
CREATE INDEX c_events_claim ON c_events(claim_id);
CREATE INDEX c_events_batch ON c_events(batch_id);
CREATE TRIGGER c_events_append_only BEFORE UPDATE ON c_events BEGIN SELECT RAISE(ABORT, 'history is permanent'); END;
CREATE TRIGGER c_events_no_delete BEFORE DELETE ON c_events BEGIN SELECT RAISE(ABORT, 'history is permanent'); END;

-- Agent keys prepare work for one person; only that person's native session
-- accepts it. Keys are stored as hashes and never travel in an export.
CREATE TABLE c_agent_keys (
  id TEXT PRIMARY KEY,
  member_email TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE c_proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('claim', 'batch')),
  agent_label TEXT NOT NULL,
  for_email TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'declined')),
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  result_id TEXT
);

-- Inert history written by the move-in kit (Base import-kit target rows).
CREATE TABLE c_history (
  destination TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  revision TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  PRIMARY KEY (destination, kind, id)
);

-- A failing row aborts the whole write batch (authority or version changed).
CREATE TABLE c_guard (ok INTEGER NOT NULL CHECK (ok = 1));
