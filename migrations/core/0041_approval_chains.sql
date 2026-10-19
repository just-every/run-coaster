-- MOVE-003: imported approval configuration uses opaque member identities;
-- each submitted revision keeps its own ordered routing snapshot.
CREATE TABLE c_import_chains (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL UNIQUE REFERENCES c_members(member_id),
  steps TEXT NOT NULL CHECK (json_valid(steps) AND json_type(steps)='array' AND json_array_length(steps)>0),
  revision TEXT NOT NULL
);
CREATE TABLE c_claim_chains (
  claim_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  chain_id TEXT NOT NULL,
  steps TEXT NOT NULL CHECK (json_valid(steps) AND json_type(steps)='array' AND json_array_length(steps)>0),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position>=0 AND position<json_array_length(steps)),
  PRIMARY KEY(claim_id,revision),
  FOREIGN KEY(claim_id,revision) REFERENCES c_revisions(claim_id,revision) ON DELETE CASCADE
);
CREATE TRIGGER c_claim_chains_keep_snapshot BEFORE UPDATE OF claim_id,revision,chain_id,steps ON c_claim_chains
  WHEN NOT EXISTS(SELECT 1 FROM c_erasing)
  BEGIN SELECT RAISE(ABORT,'claim routing history is permanent'); END;
CREATE TRIGGER c_claim_chains_no_delete BEFORE DELETE ON c_claim_chains
  WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id)
  BEGIN SELECT RAISE(ABORT,'claim routing history is permanent'); END;

-- One decision per ordered step, retaining the existing default for claims
-- with one approver and every decision already on record.
CREATE TABLE c_decisions_next (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','returned','rejected')),
  reason TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  at TEXT NOT NULL,
  exceptions TEXT NOT NULL CHECK (json_valid(exceptions)),
  on_behalf_of TEXT,
  decision_step INTEGER NOT NULL DEFAULT 0 CHECK (decision_step>=0),
  FOREIGN KEY(claim_id,revision) REFERENCES c_revisions(claim_id,revision),
  UNIQUE(claim_id,revision,decision_step)
);
INSERT INTO c_decisions_next(id,claim_id,revision,decision,reason,actor_email,at,exceptions,on_behalf_of)
  SELECT id,claim_id,revision,decision,reason,actor_email,at,exceptions,on_behalf_of FROM c_decisions;
DROP TRIGGER c_decisions_append_only;
DROP TRIGGER c_decisions_no_delete;
DROP TABLE c_decisions;
ALTER TABLE c_decisions_next RENAME TO c_decisions;
CREATE TRIGGER c_decisions_append_only BEFORE UPDATE ON c_decisions
  WHEN NOT EXISTS(SELECT 1 FROM c_erasing)
  BEGIN SELECT RAISE(ABORT,'claim history is permanent'); END;
CREATE TRIGGER c_decisions_no_delete BEFORE DELETE ON c_decisions
  WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id)
  BEGIN SELECT RAISE(ABORT,'claim history is permanent'); END;
