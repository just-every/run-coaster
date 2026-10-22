-- CODE-002: versioned human-authored rules; append-only suggestions, feedback and human coding observations.
CREATE TABLE c_auto_coding_epoch(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
INSERT INTO c_auto_coding_epoch VALUES(1,0);
CREATE TABLE c_auto_coding_rules (
 id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('merchant','mcc')),
 scope TEXT NOT NULL CHECK(scope IN ('finance','personal')), owner_email TEXT NOT NULL,
 merchant TEXT NOT NULL, merchant_key TEXT NOT NULL, fields TEXT NOT NULL CHECK(json_valid(fields)),
 active INTEGER NOT NULL CHECK(active IN (0,1)), set_by TEXT NOT NULL, set_at TEXT NOT NULL,
 PRIMARY KEY(id,version)
);
CREATE INDEX c_auto_coding_rule_match ON c_auto_coding_rules(merchant_key,scope,owner_email,version);
CREATE TABLE c_auto_coding_contexts (
 target_kind TEXT NOT NULL CHECK(target_kind IN ('item','receipt')), target_id TEXT NOT NULL,
 employee_email TEXT NOT NULL, merchant TEXT NOT NULL, merchant_key TEXT NOT NULL, mcc TEXT NOT NULL DEFAULT '',
 values_json TEXT NOT NULL CHECK(json_valid(values_json)), human_fields TEXT NOT NULL CHECK(json_valid(human_fields)),
 version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY(target_kind,target_id)
);
CREATE TABLE c_auto_coding_suggestions (
 id TEXT PRIMARY KEY, target_kind TEXT NOT NULL CHECK(target_kind IN ('item','receipt')), target_id TEXT NOT NULL,
 employee_email TEXT NOT NULL, claim_id TEXT, merchant_key TEXT NOT NULL, context_version INTEGER NOT NULL,
 fields TEXT NOT NULL CHECK(json_valid(fields)), applied_fields TEXT NOT NULL CHECK(json_valid(applied_fields)),
 evidence TEXT NOT NULL CHECK(json_valid(evidence)), catalog_version INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX c_auto_coding_target ON c_auto_coding_suggestions(target_kind,target_id,created_at);
CREATE TABLE c_auto_coding_feedback (
 suggestion_id TEXT PRIMARY KEY REFERENCES c_auto_coding_suggestions(id), action TEXT NOT NULL CHECK(action IN ('accept','override')),
 values_json TEXT NOT NULL CHECK(json_valid(values_json)), actor_email TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE c_auto_coding_observations (
 id INTEGER PRIMARY KEY AUTOINCREMENT, employee_email TEXT NOT NULL, department_id TEXT NOT NULL DEFAULT '',
 merchant_key TEXT NOT NULL, fields TEXT NOT NULL CHECK(json_valid(fields)),
 target_kind TEXT NOT NULL CHECK(target_kind IN ('item','receipt')), target_id TEXT NOT NULL,
 spent_on TEXT NOT NULL, observed_at TEXT NOT NULL
);
CREATE INDEX c_auto_coding_learning ON c_auto_coding_observations(merchant_key,employee_email,id);
CREATE TABLE c_auto_coding_flags (
 rule_id TEXT NOT NULL, rule_version INTEGER NOT NULL, catalog_version INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(rule_id,rule_version,catalog_version)
);
CREATE TRIGGER c_auto_coding_rules_immutable BEFORE UPDATE ON c_auto_coding_rules WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'coding rule versions are permanent'); END;
CREATE TRIGGER c_auto_coding_rules_no_delete BEFORE DELETE ON c_auto_coding_rules WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'coding rule versions are permanent'); END;
CREATE TRIGGER c_auto_coding_suggestions_immutable BEFORE UPDATE ON c_auto_coding_suggestions WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'coding suggestions are permanent'); END;
CREATE TRIGGER c_auto_coding_suggestions_no_delete BEFORE DELETE ON c_auto_coding_suggestions WHEN NOT EXISTS(SELECT 1 FROM c_erasing) AND NOT (OLD.target_kind='item' AND EXISTS(SELECT 1 FROM c_items i JOIN c_expiring e ON e.target=i.claim_id WHERE i.id=OLD.target_id)) BEGIN SELECT RAISE(ABORT,'coding suggestions are permanent'); END;
CREATE TRIGGER c_auto_coding_feedback_immutable BEFORE UPDATE ON c_auto_coding_feedback WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'coding feedback is permanent'); END;
CREATE TRIGGER c_auto_coding_feedback_no_delete BEFORE DELETE ON c_auto_coding_feedback WHEN NOT EXISTS(SELECT 1 FROM c_erasing) AND NOT (EXISTS(SELECT 1 FROM c_auto_coding_suggestions s JOIN c_items i ON i.id=s.target_id JOIN c_expiring e ON e.target=i.claim_id WHERE s.id=OLD.suggestion_id AND s.target_kind='item')) BEGIN SELECT RAISE(ABORT,'coding feedback is permanent'); END;
CREATE TRIGGER c_auto_coding_observations_immutable BEFORE UPDATE ON c_auto_coding_observations WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'coding observations are permanent'); END;
CREATE TRIGGER c_auto_coding_observations_no_delete BEFORE DELETE ON c_auto_coding_observations WHEN NOT EXISTS(SELECT 1 FROM c_erasing) AND NOT (OLD.target_kind='item' AND EXISTS(SELECT 1 FROM c_items i JOIN c_expiring e ON e.target=i.claim_id WHERE i.id=OLD.target_id)) BEGIN SELECT RAISE(ABORT,'coding observations are permanent'); END;
