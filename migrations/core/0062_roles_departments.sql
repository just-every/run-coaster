-- ADMIN-001: the admin, card admin and bookkeeper roles, and departments with heads. A person's powers are the union of
-- their roles; the manager hierarchy is the approving-manager chain already kept on each member.
CREATE TABLE c_departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
  head_email TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER c_departments_no_delete BEFORE DELETE ON c_departments BEGIN SELECT RAISE(ABORT, 'a department is retired, not deleted'); END;
ALTER TABLE c_departments ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));
ALTER TABLE c_members ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1));
ALTER TABLE c_members ADD COLUMN is_card_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_card_admin IN (0, 1));
ALTER TABLE c_members ADD COLUMN is_bookkeeper INTEGER NOT NULL DEFAULT 0 CHECK (is_bookkeeper IN (0, 1));
ALTER TABLE c_members ADD COLUMN department_id TEXT REFERENCES c_departments(id);
CREATE INDEX c_members_department ON c_members(department_id) WHERE department_id IS NOT NULL;

-- REPORT-004: a budget can cover a department. The scope check is widened by rebuilding the table with its history.
CREATE TABLE c_budgets_next (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('entity', 'category', 'cost-centre', 'department')),
  scope_key TEXT NOT NULL DEFAULT '',
  per_member INTEGER NOT NULL CHECK (per_member IN (0, 1)),
  period TEXT NOT NULL CHECK (period IN ('monthly', 'quarterly', 'yearly')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  owner_email TEXT NOT NULL,
  thresholds TEXT NOT NULL CHECK (json_valid(thresholds)),
  policy_rule INTEGER NOT NULL CHECK (policy_rule IN (0, 1)),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  alert_amounts INTEGER NOT NULL DEFAULT 0 CHECK (alert_amounts IN (0, 1)),
  scope_category TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (id, version)
);
INSERT INTO c_budgets_next(id,version,name,scope,scope_key,per_member,period,amount_minor,owner_email,thresholds,policy_rule,retired,set_by,set_at,alert_amounts)
  SELECT id,version,name,scope,scope_key,per_member,period,amount_minor,owner_email,thresholds,policy_rule,retired,set_by,set_at,alert_amounts FROM c_budgets;
DROP TABLE c_budgets;
ALTER TABLE c_budgets_next RENAME TO c_budgets;
CREATE TRIGGER c_budgets_append_only BEFORE UPDATE ON c_budgets WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
CREATE TRIGGER c_budgets_no_delete BEFORE DELETE ON c_budgets BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;

-- CLAIM-009: an allowance can be set for a department; its stipend goes to that department's members only.
ALTER TABLE c_allowances ADD COLUMN department_id TEXT REFERENCES c_departments(id);

-- FOLLOWUP-002: finance's escalation chain, by role and department. Each save is a new version; a department's own chain
-- wins over the default chain ('' department), and with neither the approving manager then finance applies.
CREATE TABLE c_escalation_chains (
  department_id TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL CHECK (version >= 1),
  steps TEXT NOT NULL CHECK (json_valid(steps)),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  PRIMARY KEY (department_id, version)
);
CREATE TRIGGER c_escalation_chains_append_only BEFORE UPDATE ON c_escalation_chains WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT, 'escalation history is permanent'); END;
CREATE TRIGGER c_escalation_chains_no_delete BEFORE DELETE ON c_escalation_chains BEGIN SELECT RAISE(ABORT, 'escalation history is permanent'); END;

-- ADMIN-001: deactivating a cardholder hands each unsubmitted card charge to a named successor. The charge keeps every
-- statement fact; only its cardholder and report move, and only with the recorded handoff.
CREATE TABLE c_card_handoffs (
  charge_id TEXT NOT NULL,
  from_email TEXT NOT NULL,
  to_email TEXT NOT NULL,
  from_claim TEXT NOT NULL,
  to_claim TEXT NOT NULL,
  detached_original TEXT,
  at TEXT NOT NULL,
  by_email TEXT NOT NULL,
  PRIMARY KEY (charge_id, at)
);
CREATE TRIGGER c_card_handoffs_append_only BEFORE UPDATE ON c_card_handoffs WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT, 'a card charge handoff is permanent'); END;
CREATE TRIGGER c_card_handoffs_no_delete BEFORE DELETE ON c_card_handoffs BEGIN SELECT RAISE(ABORT, 'a card charge handoff is permanent'); END;
DROP TRIGGER c_card_charges_immutable;
CREATE TRIGGER c_card_charges_immutable BEFORE UPDATE ON c_card_charges WHEN NOT EXISTS(SELECT 1 FROM c_erasing) AND NOT (
  NEW.id IS OLD.id AND NEW.file_id IS OLD.file_id AND NEW.card_id IS OLD.card_id AND NEW.transaction_key IS OLD.transaction_key AND NEW.posted_on IS OLD.posted_on
  AND NEW.transaction_on IS OLD.transaction_on AND NEW.descriptor IS OLD.descriptor AND NEW.memo IS OLD.memo AND NEW.amount_minor IS OLD.amount_minor AND NEW.currency IS OLD.currency
  AND NEW.original_minor IS OLD.original_minor AND NEW.original_currency IS OLD.original_currency AND NEW.item_id IS OLD.item_id AND NEW.category_id IS OLD.category_id AND NEW.created_at IS OLD.created_at
  AND EXISTS(SELECT 1 FROM c_card_handoffs h WHERE h.charge_id=OLD.id AND h.from_email=OLD.employee_email AND h.to_email=NEW.employee_email AND h.from_claim=OLD.claim_id AND h.to_claim=NEW.claim_id))
  BEGIN SELECT RAISE(ABORT, 'statement facts are immutable'); END;
