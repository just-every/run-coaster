CREATE TABLE c_entities (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, timezone TEXT NOT NULL,
 receipt_threshold_minor INTEGER NOT NULL DEFAULT 7500, preapproval_threshold_minor INTEGER,
 sales_tax_account TEXT NOT NULL DEFAULT '', sales_tax_code TEXT NOT NULL DEFAULT '',
 fx_enabled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO c_entities(id,name,currency,timezone,receipt_threshold_minor,preapproval_threshold_minor,sales_tax_account,sales_tax_code,fx_enabled,created_at,updated_at)
 SELECT 'primary',name,currency,timezone,receipt_threshold_minor,preapproval_threshold_minor,sales_tax_account,sales_tax_code,fx_enabled,updated_at,updated_at FROM c_business;
INSERT OR IGNORE INTO c_entities(id,name,currency,timezone,created_at,updated_at) VALUES('primary','Primary entity','USD','America/Chicago','1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z');
CREATE TABLE c_entity_members (
 entity_id TEXT NOT NULL REFERENCES c_entities(id), email TEXT NOT NULL REFERENCES c_members(email) ON UPDATE CASCADE,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), PRIMARY KEY(entity_id,email)
);
INSERT INTO c_entity_members(entity_id,email) SELECT 'primary',email FROM c_members;
CREATE TRIGGER c_member_primary_entity AFTER INSERT ON c_members BEGIN
 INSERT INTO c_entity_members(entity_id,email) VALUES('primary',NEW.email);
END;
ALTER TABLE c_claims ADD COLUMN entity_id TEXT NOT NULL DEFAULT 'primary';
PRAGMA defer_foreign_keys=ON;
CREATE TABLE c_categories_entities (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, account_code TEXT NOT NULL, tax_code TEXT NOT NULL,
 limit_minor INTEGER CHECK(limit_minor IS NULL OR limit_minor>=0), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 receipt_always INTEGER NOT NULL DEFAULT 0 CHECK(receipt_always IN (0,1)),
 per_person_limit_minor INTEGER CHECK(per_person_limit_minor IS NULL OR per_person_limit_minor>=0),
 required_fields TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(required_fields)),
 ledger_account_id TEXT REFERENCES c_coding_values(id),ledger_account_snapshot TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(ledger_account_snapshot)),
 entity_id TEXT NOT NULL DEFAULT 'primary' REFERENCES c_entities(id), UNIQUE(entity_id,name)
);
INSERT INTO c_categories_entities(id,name,account_code,tax_code,limit_minor,active,receipt_always,per_person_limit_minor,required_fields,ledger_account_id,ledger_account_snapshot)
 SELECT id,name,account_code,tax_code,limit_minor,active,receipt_always,per_person_limit_minor,required_fields,ledger_account_id,ledger_account_snapshot FROM c_categories;
DROP TABLE c_categories;
ALTER TABLE c_categories_entities RENAME TO c_categories;
INSERT INTO c_guard SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
DELETE FROM c_guard;
PRAGMA defer_foreign_keys=OFF;
ALTER TABLE c_policies ADD COLUMN entity_id TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE c_approval_workflows ADD COLUMN entity_id TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE c_batches ADD COLUMN entity_id TEXT NOT NULL DEFAULT 'primary';
CREATE INDEX c_claim_entity ON c_claims(entity_id);
CREATE TABLE c_entity_reports(id TEXT PRIMARY KEY,created_by TEXT NOT NULL,created_at TEXT NOT NULL,snapshot TEXT NOT NULL CHECK(json_valid(snapshot)));
CREATE TRIGGER c_entity_report_immutable_update BEFORE UPDATE ON c_entity_reports WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'Consolidated reports are immutable'); END;
CREATE TRIGGER c_entity_report_immutable_delete BEFORE DELETE ON c_entity_reports BEGIN SELECT RAISE(ABORT,'Consolidated reports are immutable'); END;

-- Existing populated tables cannot add a non-null foreign key with a default in SQLite.
-- These guards enforce the same reference and keep financial attribution immutable.
CREATE TRIGGER c_claim_entity_insert BEFORE INSERT ON c_claims BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM c_entities WHERE id=NEW.entity_id AND currency=NEW.currency) THEN RAISE(ABORT,'Claim entity and currency must agree') END;
END;
CREATE TRIGGER c_claim_entity_immutable BEFORE UPDATE OF entity_id,currency ON c_claims WHEN NEW.entity_id<>OLD.entity_id OR NEW.currency<>OLD.currency BEGIN
 SELECT RAISE(ABORT,'Claim entity and currency are immutable');
END;
CREATE TRIGGER c_batch_entity_insert BEFORE INSERT ON c_batches BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM c_entities WHERE id=NEW.entity_id AND currency=NEW.currency) THEN RAISE(ABORT,'Batch entity and currency must agree') END;
END;
CREATE TRIGGER c_batch_entity_immutable BEFORE UPDATE OF entity_id,currency ON c_batches WHEN NEW.entity_id<>OLD.entity_id OR NEW.currency<>OLD.currency BEGIN
 SELECT RAISE(ABORT,'Batch entity and currency are immutable');
END;
CREATE TRIGGER c_batch_entity_claim BEFORE INSERT ON c_batch_claims BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM c_claims c JOIN c_batches b ON b.id=NEW.batch_id WHERE c.id=NEW.claim_id AND c.entity_id=b.entity_id AND c.currency=b.currency) THEN RAISE(ABORT,'A batch belongs to one entity') END;
END;
CREATE TRIGGER c_policy_entity_insert BEFORE INSERT ON c_policies BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM c_entities WHERE id=NEW.entity_id) THEN RAISE(ABORT,'Policy entity not found') END;
END;
CREATE TRIGGER c_workflow_entity_insert BEFORE INSERT ON c_approval_workflows BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM c_entities WHERE id=NEW.entity_id) THEN RAISE(ABORT,'Workflow entity not found') END;
END;
CREATE TRIGGER c_allocation_entity_insert BEFORE INSERT ON c_allocations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM c_items i JOIN c_claims c ON c.id=i.claim_id JOIN c_categories g ON g.id=NEW.category_id WHERE i.id=NEW.item_id AND c.entity_id=g.entity_id) THEN RAISE(ABORT,'Category belongs to another entity') END;
END;
CREATE TRIGGER c_allocation_entity_update BEFORE UPDATE OF category_id,item_id ON c_allocations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM c_items i JOIN c_claims c ON c.id=i.claim_id JOIN c_categories g ON g.id=NEW.category_id WHERE i.id=NEW.item_id AND c.entity_id=g.entity_id) THEN RAISE(ABORT,'Category belongs to another entity') END;
END;
CREATE TRIGGER c_item_entity_move BEFORE UPDATE OF claim_id ON c_items BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM c_allocations a JOIN c_categories g ON g.id=a.category_id JOIN c_claims c ON c.id=NEW.claim_id WHERE a.item_id=OLD.id AND g.entity_id<>c.entity_id) THEN RAISE(ABORT,'Expense belongs to another entity') END;
END;
