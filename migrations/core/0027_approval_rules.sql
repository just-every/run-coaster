-- Rule-based auto-approval (APPROVE-004). Every change the owner makes to the
-- rule is a new numbered version; a claim the rule approves records "rule vN".
CREATE TABLE c_approval_rules (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  limit_minor INTEGER CHECK (limit_minor IS NULL OR limit_minor > 0),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  CHECK (enabled = 0 OR limit_minor IS NOT NULL)
);
CREATE TRIGGER c_approval_rules_append_only BEFORE UPDATE ON c_approval_rules BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
CREATE TRIGGER c_approval_rules_no_delete BEFORE DELETE ON c_approval_rules BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
