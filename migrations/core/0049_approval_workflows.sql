-- APPROVE-001: versioned owner configuration and frozen per-revision tasks.
CREATE TABLE c_approval_workflows (
 version INTEGER PRIMARY KEY,
 rules TEXT NOT NULL CHECK(json_valid(rules)),
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TRIGGER c_approval_workflows_immutable BEFORE UPDATE ON c_approval_workflows WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'workflow versions are permanent'); END;
CREATE TABLE c_workflow_tasks (
 kind TEXT NOT NULL CHECK(kind IN ('claim','request')),
 record_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 slot INTEGER NOT NULL,
 stage INTEGER NOT NULL,
 email TEXT NOT NULL,
 on_behalf_of TEXT,
 role TEXT NOT NULL CHECK(role IN ('manager','finance')),
 status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','approved')),
 PRIMARY KEY(kind,record_id,revision,slot)
);
ALTER TABLE c_decisions ADD COLUMN workflow_final INTEGER NOT NULL DEFAULT 1 CHECK(workflow_final IN (0,1));
ALTER TABLE c_requests ADD COLUMN workflow TEXT CHECK(workflow IS NULL OR json_valid(workflow));
CREATE TRIGGER c_approval_workflows_no_delete BEFORE DELETE ON c_approval_workflows BEGIN SELECT RAISE(ABORT,'workflow versions are permanent'); END;
