-- Personal classification is separate from immutable company-liability charge facts.
-- There is deliberately no local payment or balance-clearance operation.
CREATE TABLE c_card_personal_spend (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE CHECK (length(source_key)=64),
  charge_id TEXT NOT NULL UNIQUE,
  card_id TEXT NOT NULL,
  employee_email TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  claim_version INTEGER NOT NULL CHECK (claim_version>=1),
  liability TEXT NOT NULL CHECK (liability='company'),
  classification TEXT NOT NULL CHECK (classification='personal'),
  amount_minor INTEGER NOT NULL CHECK (amount_minor>0),
  outstanding_minor INTEGER NOT NULL CHECK (outstanding_minor=amount_minor),
  currency TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  actor_email TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel='app'),
  marked_at TEXT NOT NULL
);
CREATE INDEX c_card_personal_employee ON c_card_personal_spend(employee_email);
CREATE TRIGGER c_card_personal_immutable BEFORE UPDATE ON c_card_personal_spend
  WHEN NOT EXISTS(SELECT 1 FROM c_erasing)
  BEGIN SELECT RAISE(ABORT,'personal-spend history is permanent'); END;
CREATE TRIGGER c_card_personal_no_delete BEFORE DELETE ON c_card_personal_spend
  BEGIN SELECT RAISE(ABORT,'personal-spend history is permanent'); END;
