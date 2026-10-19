-- Budget alerts name the percentage and period; amounts go in the email only
-- when the owner opts that budget in (REPORT-004, ct 19 Oct 05:16Z).
ALTER TABLE c_budgets ADD COLUMN alert_amounts INTEGER NOT NULL DEFAULT 0 CHECK (alert_amounts IN (0, 1));
