-- Escalation with service levels (FOLLOWUP-002). An approval escalates once it
-- passes the service level, anything else once its reminders are exhausted plus
-- the gap: to the person's approving manager, then finance; NULL gap = off.
ALTER TABLE c_business ADD COLUMN service_level_days INTEGER NOT NULL DEFAULT 3 CHECK (service_level_days BETWEEN 1 AND 30);
ALTER TABLE c_business ADD COLUMN escalation_days INTEGER DEFAULT 2 CHECK (escalation_days IS NULL OR escalation_days BETWEEN 1 AND 30);
CREATE TABLE c_escalations (
  key TEXT NOT NULL REFERENCES c_reminder_items(key),
  level INTEGER NOT NULL CHECK (level IN (1, 2)),
  recipients TEXT NOT NULL CHECK (json_valid(recipients)),
  sent_at TEXT NOT NULL,
  PRIMARY KEY (key, level)
);
CREATE TRIGGER c_escalations_append_only BEFORE UPDATE ON c_escalations BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
CREATE TRIGGER c_escalations_no_delete BEFORE DELETE ON c_escalations BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
