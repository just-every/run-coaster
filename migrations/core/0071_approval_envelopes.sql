-- AGENT-005 owner grants/revokes a deterministic compliant-spend envelope.
CREATE TABLE c_approval_envelopes (
 version INTEGER PRIMARY KEY CHECK(version>=1),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 limit_minor INTEGER CHECK(limit_minor>0),
 set_by TEXT NOT NULL,
 set_at TEXT NOT NULL,
 CHECK(enabled=0 OR limit_minor IS NOT NULL)
);
CREATE TRIGGER c_approval_envelopes_append_only BEFORE UPDATE ON c_approval_envelopes
 WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'approval envelopes are permanent'); END;
CREATE TRIGGER c_approval_envelopes_no_delete BEFORE DELETE ON c_approval_envelopes
 BEGIN SELECT RAISE(ABORT,'approval envelopes are permanent'); END;
