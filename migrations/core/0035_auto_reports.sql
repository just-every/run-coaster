-- Automatic reports and scheduled submission (AUTO-001). An expense added without
-- choosing a claim is filed into the employee's open automatic report for its
-- month, or for the spend request (trip) it is linked to; on the owner's schedule
-- each automatic report submits its complete expenses and keeps the rest behind.
ALTER TABLE c_business ADD COLUMN auto_submit TEXT CHECK (auto_submit IS NULL OR auto_submit IN ('daily', 'weekly', 'twice-monthly', 'monthly'));
ALTER TABLE c_claims ADD COLUMN auto_key TEXT;
CREATE INDEX c_claims_auto ON c_claims(employee_email, auto_key);
-- One scheduled submission run per business day it falls on.
CREATE TABLE c_auto_runs (
  day TEXT PRIMARY KEY,
  ran_at TEXT NOT NULL
);
