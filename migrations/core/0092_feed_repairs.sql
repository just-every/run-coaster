-- AGENT-004 native feed repair: agent-prepared proposals, person-confirmed tasks and evidence-bound resolutions.
-- Nothing here changes a connection, credential or schedule; missing or unverified delivery evidence is never zero spend.
CREATE TABLE c_feed_repair_proposals (
 id TEXT PRIMARY KEY,
 feed_id TEXT NOT NULL REFERENCES c_program_feeds(id),
 feed_version INTEGER NOT NULL,
 for_email TEXT NOT NULL,
 agent_label TEXT NOT NULL,
 evidence TEXT NOT NULL CHECK(json_valid(evidence)),
 stamp TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('proposed','accepted','declined','superseded')),
 created_at TEXT NOT NULL,
 decided_by TEXT,
 decided_at TEXT
);
CREATE UNIQUE INDEX c_feed_repair_pending ON c_feed_repair_proposals(feed_id,for_email) WHERE status='proposed';
-- A proposal is decided once; its prepared evidence never changes. Only ERASURE-001 rewrites a person's address.
CREATE TRIGGER c_feed_repair_proposals_decided BEFORE UPDATE ON c_feed_repair_proposals
 WHEN NOT EXISTS(SELECT 1 FROM c_erasing) AND (OLD.status<>'proposed' OR NEW.status='proposed' OR NEW.id IS NOT OLD.id OR NEW.feed_id IS NOT OLD.feed_id OR NEW.feed_version IS NOT OLD.feed_version
  OR NEW.for_email IS NOT OLD.for_email OR NEW.agent_label IS NOT OLD.agent_label OR NEW.evidence IS NOT OLD.evidence OR NEW.stamp IS NOT OLD.stamp OR NEW.created_at IS NOT OLD.created_at)
 BEGIN SELECT RAISE(ABORT,'feed repair proposals are permanent'); END;
CREATE TRIGGER c_feed_repair_proposals_no_delete BEFORE DELETE ON c_feed_repair_proposals BEGIN SELECT RAISE(ABORT,'feed repair proposals are permanent'); END;
CREATE TABLE c_feed_repair_tasks (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 feed_id TEXT NOT NULL REFERENCES c_program_feeds(id),
 feed_version INTEGER NOT NULL,
 delivery_date TEXT NOT NULL,
 deadline TEXT NOT NULL,
 missed_seq INTEGER NOT NULL REFERENCES c_program_health(seq),
 cause TEXT NOT NULL CHECK(cause IN ('missing-delivery','recorded-failure')),
 proposal_id TEXT NOT NULL REFERENCES c_feed_repair_proposals(id),
 assignee TEXT NOT NULL,
 agent_label TEXT NOT NULL,
 opened_at TEXT NOT NULL,
 UNIQUE(feed_id,delivery_date)
);
CREATE TRIGGER c_feed_repair_tasks_no_update BEFORE UPDATE ON c_feed_repair_tasks WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'feed repair tasks are permanent'); END;
CREATE TRIGGER c_feed_repair_tasks_no_delete BEFORE DELETE ON c_feed_repair_tasks BEGIN SELECT RAISE(ABORT,'feed repair tasks are permanent'); END;
CREATE TABLE c_feed_repair_resolutions (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 task_id TEXT NOT NULL UNIQUE REFERENCES c_feed_repair_tasks(id),
 covered_seq INTEGER NOT NULL REFERENCES c_program_health(seq),
 delivery_id TEXT NOT NULL REFERENCES c_program_deliveries(id),
 resolved_by TEXT NOT NULL,
 resolved_at TEXT NOT NULL
);
CREATE TRIGGER c_feed_repair_resolutions_no_update BEFORE UPDATE ON c_feed_repair_resolutions WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'feed repair resolutions are permanent'); END;
CREATE TRIGGER c_feed_repair_resolutions_no_delete BEFORE DELETE ON c_feed_repair_resolutions BEGIN SELECT RAISE(ABORT,'feed repair resolutions are permanent'); END;
