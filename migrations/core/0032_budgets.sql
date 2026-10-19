-- Budgets with threshold alerts (REPORT-004). Each save is a new version of the
-- budget; alerts are sent once per budget, period, member and threshold.
CREATE TABLE c_budgets (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('entity', 'category', 'cost-centre')),
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
  PRIMARY KEY (id, version)
);
CREATE TRIGGER c_budgets_append_only BEFORE UPDATE ON c_budgets BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
CREATE TRIGGER c_budgets_no_delete BEFORE DELETE ON c_budgets BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
CREATE TABLE c_budget_alerts (
  budget_id TEXT NOT NULL,
  period TEXT NOT NULL,
  member TEXT NOT NULL DEFAULT '',
  threshold INTEGER NOT NULL,
  recipients TEXT NOT NULL CHECK (json_valid(recipients)),
  sent_at TEXT NOT NULL,
  PRIMARY KEY (budget_id, period, member, threshold)
);
CREATE TRIGGER c_budget_alerts_append_only BEFORE UPDATE ON c_budget_alerts BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
CREATE TRIGGER c_budget_alerts_no_delete BEFORE DELETE ON c_budget_alerts BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
