-- REPORT-005: expenses explicitly marked for customer rebilling.
ALTER TABLE c_items ADD COLUMN billable INTEGER NOT NULL DEFAULT 0 CHECK (billable IN (0,1));
ALTER TABLE c_items ADD COLUMN customer TEXT NOT NULL DEFAULT '';
