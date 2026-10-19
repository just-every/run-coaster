-- Reminders that chase people (FOLLOWUP-001). Finance sets the business days
-- after which each open item is chased and the quiet hours; an item's age counts
-- from the first hourly run that saw it open, and each step is sent once.
ALTER TABLE c_business ADD COLUMN reminder_days TEXT NOT NULL DEFAULT '[2,5,10]' CHECK (json_valid(reminder_days));
ALTER TABLE c_business ADD COLUMN quiet_from INTEGER NOT NULL DEFAULT 20 CHECK (quiet_from BETWEEN 0 AND 23);
ALTER TABLE c_business ADD COLUMN quiet_until INTEGER NOT NULL DEFAULT 8 CHECK (quiet_until BETWEEN 0 AND 23);
CREATE TABLE c_reminder_items (
  key TEXT PRIMARY KEY,
  person TEXT NOT NULL,
  claim_id TEXT NOT NULL REFERENCES c_claims(id),
  first_seen_at TEXT NOT NULL
);
CREATE TABLE c_reminders (
  key TEXT NOT NULL REFERENCES c_reminder_items(key),
  step INTEGER NOT NULL,
  person TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (key, step)
);
CREATE TRIGGER c_reminders_append_only BEFORE UPDATE ON c_reminders BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
CREATE TRIGGER c_reminders_no_delete BEFORE DELETE ON c_reminders BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
