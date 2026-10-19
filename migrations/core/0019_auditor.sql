-- Auditors read every record and change nothing (REPORT-003). History search
-- and audit packs read history lines by time.
ALTER TABLE c_members ADD COLUMN is_auditor INTEGER NOT NULL DEFAULT 0 CHECK (is_auditor IN (0, 1));
CREATE INDEX c_events_at ON c_events(at);
