-- Versioned policy rules (POLICY-001). Finance publishes the whole rule set as a
-- new numbered version with the day it takes effect; versions are never changed
-- or removed, and each policy exception names the version that raised it.
CREATE TABLE c_policies (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  effective_from TEXT NOT NULL,
  rules TEXT NOT NULL CHECK (json_valid(rules)),
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL
);
CREATE TRIGGER c_policies_append_only BEFORE UPDATE ON c_policies WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT, 'policy history is permanent'); END;
CREATE TRIGGER c_policies_no_delete BEFORE DELETE ON c_policies BEGIN SELECT RAISE(ABORT, 'policy history is permanent'); END;
