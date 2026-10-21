-- CAPTURE-004 / FEED-004: private consent and schedule provenance. Existing lifecycle lines are preserved.
CREATE TABLE c_capture_lifecycle_next (
  receipt_id TEXT NOT NULL REFERENCES c_capture_receipts(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  kind TEXT NOT NULL CHECK (kind IN ('discarded','merged','attached','detached','match-details','match-withdrawn','match-rejected')),
  reason TEXT NOT NULL,
  survivor_id TEXT REFERENCES c_capture_receipts(id),
  claim_id TEXT,
  item_id TEXT,
  at TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  on_behalf_of TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('app','schedule')),
  match_data TEXT CHECK (match_data IS NULL OR json_valid(match_data)),
  PRIMARY KEY (receipt_id,sequence),
  CHECK ((kind IN ('attached','detached')) = (claim_id IS NOT NULL AND item_id IS NOT NULL)),
  CHECK ((kind = 'merged') = (survivor_id IS NOT NULL) AND (survivor_id IS NULL OR survivor_id <> receipt_id))
);
INSERT INTO c_capture_lifecycle_next(receipt_id,sequence,kind,reason,survivor_id,claim_id,item_id,at,actor_email,on_behalf_of,channel)
 SELECT receipt_id,sequence,kind,reason,survivor_id,claim_id,item_id,at,actor_email,on_behalf_of,channel FROM c_capture_lifecycle;
DROP TABLE c_capture_lifecycle;
ALTER TABLE c_capture_lifecycle_next RENAME TO c_capture_lifecycle;
CREATE UNIQUE INDEX c_capture_lifecycle_terminal ON c_capture_lifecycle(receipt_id) WHERE kind IN ('discarded','merged');
CREATE TRIGGER c_capture_lifecycle_keep_facts BEFORE UPDATE OF receipt_id,sequence,kind,survivor_id,claim_id,item_id,at,channel ON c_capture_lifecycle
BEGIN SELECT RAISE(ABORT,'receipt lifecycle is permanent'); END;
CREATE TRIGGER c_capture_lifecycle_keep_identity BEFORE UPDATE OF actor_email,on_behalf_of,reason ON c_capture_lifecycle WHEN NOT EXISTS(SELECT 1 FROM c_capture_erasing)
BEGIN SELECT RAISE(ABORT,'receipt lifecycle is permanent'); END;
CREATE TRIGGER c_capture_lifecycle_no_delete BEFORE DELETE ON c_capture_lifecycle
BEGIN SELECT RAISE(ABORT,'receipt lifecycle is permanent'); END;
-- Expanded replacements are retained, never truncated. Only an identical-hash merge may carry no reason.
CREATE TRIGGER c_capture_lifecycle_reason_insert BEFORE INSERT ON c_capture_lifecycle
WHEN typeof(NEW.reason)<>'text' OR length(CAST(NEW.reason AS BLOB)) NOT BETWEEN (CASE WHEN NEW.kind='discarded' THEN 1 ELSE 0 END) AND 22000
BEGIN SELECT RAISE(ABORT,'receipt reason exceeds its byte bound'); END;
CREATE TRIGGER c_capture_lifecycle_reason_update BEFORE UPDATE OF reason ON c_capture_lifecycle
WHEN NOT EXISTS(SELECT 1 FROM c_capture_erasing) OR OLD.reason=''
  OR typeof(NEW.reason)<>'text' OR length(CAST(NEW.reason AS BLOB)) NOT BETWEEN 1 AND 22000
BEGIN SELECT RAISE(ABORT,'receipt reason is permanent outside bounded erasure'); END;
-- A survivor is the same employee's own original that has no terminal disposition yet; a merge without
-- identical SHA-256 states its reason.
CREATE TRIGGER c_capture_lifecycle_merge_insert BEFORE INSERT ON c_capture_lifecycle
WHEN NEW.kind='merged' AND NOT EXISTS(
  SELECT 1 FROM c_capture_receipts d JOIN c_capture_receipts s ON s.owner_email=d.owner_email AND s.id=NEW.survivor_id
  WHERE d.id=NEW.receipt_id AND NEW.at>=s.uploaded_at AND (NEW.reason<>'' OR s.sha256=d.sha256)
    AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle t WHERE t.receipt_id=s.id AND t.kind IN ('discarded','merged')))
BEGIN SELECT RAISE(ABORT,'a merge needs its own open survivor and, unless identical, a reason'); END;

CREATE TRIGGER c_capture_lifecycle_sequence BEFORE INSERT ON c_capture_lifecycle
WHEN NEW.sequence<>(SELECT COALESCE(MAX(sequence),0)+1 FROM c_capture_lifecycle WHERE receipt_id=NEW.receipt_id)
 OR EXISTS(SELECT 1 FROM c_capture_lifecycle WHERE receipt_id=NEW.receipt_id AND kind IN ('discarded','merged'))
BEGIN SELECT RAISE(ABORT,'receipt lifecycle sequence is permanent'); END;
-- Disposition may never retire an original that a live expense still carries.
CREATE TRIGGER c_capture_lifecycle_open_disposition BEFORE INSERT ON c_capture_lifecycle
WHEN NEW.kind IN ('discarded','merged') AND EXISTS(
 SELECT 1 FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id WHERE a.capture_receipt_id=NEW.receipt_id
 OR (NEW.kind='merged' AND a.capture_receipt_id=NEW.survivor_id))
BEGIN SELECT RAISE(ABORT,'detach receipts before disposition'); END;
CREATE TRIGGER c_capture_lifecycle_attachment BEFORE INSERT ON c_capture_lifecycle
WHEN NEW.kind IN ('attached','detached') AND (
 NEW.reason<>'' OR NOT EXISTS(SELECT 1 FROM c_items i JOIN c_claims c ON c.id=i.claim_id JOIN c_capture_receipts r ON r.id=NEW.receipt_id
 WHERE i.id=NEW.item_id AND c.id=NEW.claim_id AND c.employee_email=r.owner_email AND c.status IN ('draft','returned') AND i.kind='receipt'
 AND ((NEW.kind='attached' AND EXISTS(SELECT 1 FROM c_receipts a WHERE a.id=i.receipt_id AND a.capture_receipt_id=r.id))
 OR (NEW.kind='detached' AND i.receipt_id IS NULL)))
 OR (NEW.kind='attached' AND COALESCE((SELECT kind FROM c_capture_lifecycle WHERE receipt_id=NEW.receipt_id AND kind IN ('attached','detached') ORDER BY sequence DESC LIMIT 1),'detached')<>'detached'
 AND EXISTS(SELECT 1 FROM c_items WHERE id=(SELECT item_id FROM c_capture_lifecycle WHERE receipt_id=NEW.receipt_id AND kind IN ('attached','detached') ORDER BY sequence DESC LIMIT 1)))
 OR (NEW.kind='detached' AND COALESCE((SELECT kind FROM c_capture_lifecycle WHERE receipt_id=NEW.receipt_id AND kind IN ('attached','detached') ORDER BY sequence DESC LIMIT 1),'')<>'attached'))
BEGIN SELECT RAISE(ABORT,'attachment needs its editable employee expense and exact transition'); END;

CREATE TRIGGER c_capture_match_data_immutable BEFORE UPDATE OF match_data ON c_capture_lifecycle
 WHEN NOT EXISTS(SELECT 1 FROM c_capture_erasing)
 BEGIN SELECT RAISE(ABORT,'private match evidence is permanent'); END;
CREATE TRIGGER c_capture_match_provenance BEFORE INSERT ON c_capture_lifecycle
 WHEN NEW.channel='schedule' AND (NEW.kind<>'attached' OR NEW.actor_email<>'automation: card match'
 OR NEW.on_behalf_of IS NOT (SELECT owner_email FROM c_capture_receipts WHERE id=NEW.receipt_id) OR NEW.match_data IS NULL)
 BEGIN SELECT RAISE(ABORT,'a scheduled attachment needs card-match provenance'); END;
CREATE TRIGGER c_capture_match_choice BEFORE INSERT ON c_capture_lifecycle
 WHEN NEW.kind IN ('match-details','match-withdrawn','match-rejected') AND
 (NEW.channel<>'app' OR NEW.reason<>'' OR EXISTS(SELECT 1 FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id WHERE a.capture_receipt_id=NEW.receipt_id)
 OR (NEW.kind='match-details' AND (NEW.match_data IS NULL OR EXISTS(SELECT 1 FROM c_capture_cash_drafts WHERE receipt_id=NEW.receipt_id))))
 BEGIN SELECT RAISE(ABORT,'matching choices need an unattached original without a cash reservation'); END;

CREATE TABLE c_card_match_rules (
 version INTEGER PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 window_days INTEGER NOT NULL CHECK(window_days BETWEEN 0 AND 14),
 tip_percent INTEGER NOT NULL CHECK(tip_percent BETWEEN 0 AND 30), fx_percent INTEGER NOT NULL CHECK(fx_percent BETWEEN 0 AND 10),
 set_by TEXT NOT NULL, set_at TEXT
);
INSERT INTO c_card_match_rules VALUES(1,1,7,20,5,'installation',NULL);
CREATE TRIGGER c_card_match_rules_keep BEFORE UPDATE ON c_card_match_rules WHEN NOT EXISTS(SELECT 1 FROM c_erasing)
 BEGIN SELECT RAISE(ABORT,'matching rule versions are permanent'); END;
CREATE TRIGGER c_card_match_rules_no_delete BEFORE DELETE ON c_card_match_rules BEGIN SELECT RAISE(ABORT,'matching rule versions are permanent'); END;
CREATE TABLE c_card_match_rejections (
 receipt_id TEXT NOT NULL REFERENCES c_capture_receipts(id), charge_id TEXT NOT NULL,
 sequence INTEGER NOT NULL, PRIMARY KEY(receipt_id,charge_id),
 FOREIGN KEY(receipt_id,sequence) REFERENCES c_capture_lifecycle(receipt_id,sequence)
);
CREATE TRIGGER c_card_match_rejections_keep BEFORE UPDATE ON c_card_match_rejections BEGIN SELECT RAISE(ABORT,'a rejected pair stays rejected'); END;
CREATE TRIGGER c_card_match_rejections_no_delete BEFORE DELETE ON c_card_match_rejections BEGIN SELECT RAISE(ABORT,'a rejected pair stays rejected'); END;
-- A public match basis is tied to the receipt alias, so coding edits and old revisions retain it, while detach removes it from the live expense.
ALTER TABLE c_receipts ADD COLUMN card_match_basis TEXT CHECK(card_match_basis IS NULL OR json_valid(card_match_basis));
CREATE TRIGGER c_receipts_match_basis_keep BEFORE UPDATE OF card_match_basis ON c_receipts WHEN NOT EXISTS(SELECT 1 FROM c_erasing)
 BEGIN SELECT RAISE(ABORT,'the attachment basis is permanent'); END;
-- Derived evaluation bookkeeping contains no receipt details or identities.
CREATE TABLE c_card_match_epoch(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
INSERT INTO c_card_match_epoch VALUES(1,0);
CREATE TABLE c_card_match_generations(employee_email TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE c_card_match_checks(receipt_id TEXT PRIMARY KEY REFERENCES c_capture_receipts(id), generation INTEGER NOT NULL, rule_version INTEGER NOT NULL, evaluated_at TEXT NOT NULL);

CREATE TRIGGER c_match_dirty_c_capture_lifecycle_insert AFTER INSERT ON c_capture_lifecycle 
 BEGIN UPDATE c_card_match_epoch SET version=version+1 WHERE id=1;
 INSERT INTO c_card_match_generations(employee_email,version) VALUES((SELECT owner_email FROM c_capture_receipts WHERE id=NEW.receipt_id),1) ON CONFLICT(employee_email) DO UPDATE SET version=version+1; END;

CREATE TRIGGER c_match_dirty_c_card_charges_insert AFTER INSERT ON c_card_charges 
 BEGIN UPDATE c_card_match_epoch SET version=version+1 WHERE id=1;
 INSERT INTO c_card_match_generations(employee_email,version) VALUES(NEW.employee_email,1) ON CONFLICT(employee_email) DO UPDATE SET version=version+1; END;

CREATE TRIGGER c_match_dirty_c_card_charges_delete AFTER DELETE ON c_card_charges 
 BEGIN UPDATE c_card_match_epoch SET version=version+1 WHERE id=1;
 INSERT INTO c_card_match_generations(employee_email,version) VALUES(OLD.employee_email,1) ON CONFLICT(employee_email) DO UPDATE SET version=version+1; END;

CREATE TRIGGER c_match_dirty_c_items_update AFTER UPDATE ON c_items WHEN NEW.receipt_id IS NOT OLD.receipt_id OR NEW.claim_id IS NOT OLD.claim_id
 BEGIN UPDATE c_card_match_epoch SET version=version+1 WHERE id=1;
 INSERT INTO c_card_match_generations(employee_email,version) VALUES((SELECT employee_email FROM c_claims WHERE id=NEW.claim_id),1) ON CONFLICT(employee_email) DO UPDATE SET version=version+1; END;

CREATE TRIGGER c_match_dirty_c_claims_update AFTER UPDATE ON c_claims WHEN NEW.status IS NOT OLD.status
 BEGIN UPDATE c_card_match_epoch SET version=version+1 WHERE id=1;
 INSERT INTO c_card_match_generations(employee_email,version) VALUES(NEW.employee_email,1) ON CONFLICT(employee_email) DO UPDATE SET version=version+1; END;

CREATE TRIGGER c_match_dirty_c_members_update AFTER UPDATE ON c_members WHEN NEW.active IS NOT OLD.active OR NEW.is_employee IS NOT OLD.is_employee
 BEGIN UPDATE c_card_match_epoch SET version=version+1 WHERE id=1;
 INSERT INTO c_card_match_generations(employee_email,version) VALUES(NEW.email,1) ON CONFLICT(employee_email) DO UPDATE SET version=version+1; END;
CREATE TRIGGER c_match_dirty_account AFTER UPDATE OF status ON oa_operators WHEN NEW.status IS NOT OLD.status
 BEGIN UPDATE c_card_match_epoch SET version=version+1 WHERE id=1;
 INSERT INTO c_card_match_generations(employee_email,version) VALUES(lower(NEW.email),1) ON CONFLICT(employee_email) DO UPDATE SET version=version+1; END;
CREATE TRIGGER c_match_dirty_rule AFTER INSERT ON c_card_match_rules
 BEGIN UPDATE c_card_match_epoch SET version=version+1 WHERE id=1; END;
CREATE TRIGGER c_match_dirty_fx AFTER UPDATE OF fx_enabled ON c_business WHEN NEW.fx_enabled IS NOT OLD.fx_enabled
 BEGIN UPDATE c_card_match_epoch SET version=version+1 WHERE id=1;
 UPDATE c_card_match_generations SET version=version+1; END;

-- Keep the original report id after RETAIN-001 removes the financial expense. It remains immutable statement provenance.
ALTER TABLE c_card_charges ADD COLUMN claim_id TEXT NOT NULL DEFAULT '';
DROP TRIGGER c_card_charges_immutable;
UPDATE c_card_charges SET claim_id=COALESCE((SELECT claim_id FROM c_items WHERE id=c_card_charges.item_id),'');
CREATE TRIGGER c_card_charges_immutable BEFORE UPDATE ON c_card_charges WHEN NOT EXISTS(SELECT 1 FROM c_erasing)
 BEGIN SELECT RAISE(ABORT,'statement facts are immutable'); END;
CREATE TRIGGER c_match_dirty_item_delete AFTER DELETE ON c_items WHEN OLD.receipt_id IS NOT NULL OR OLD.card_charge_id IS NOT NULL
 BEGIN UPDATE c_card_match_epoch SET version=version+1 WHERE id=1;
 INSERT INTO c_card_match_generations(employee_email,version) SELECT employee_email,1 FROM c_claims WHERE id=OLD.claim_id
 ON CONFLICT(employee_email) DO UPDATE SET version=version+1; END;
CREATE TRIGGER c_match_dirty_item_insert AFTER INSERT ON c_items WHEN NEW.receipt_id IS NOT NULL OR NEW.card_charge_id IS NOT NULL
 BEGIN UPDATE c_card_match_epoch SET version=version+1 WHERE id=1;
 INSERT INTO c_card_match_generations(employee_email,version) SELECT employee_email,1 FROM c_claims WHERE id=NEW.claim_id
 ON CONFLICT(employee_email) DO UPDATE SET version=version+1; END;
CREATE TRIGGER c_match_dirty_account_insert AFTER INSERT ON oa_operators
 BEGIN UPDATE c_card_match_epoch SET version=version+1 WHERE id=1;
 INSERT INTO c_card_match_generations(employee_email,version) VALUES(lower(NEW.email),1) ON CONFLICT(employee_email) DO UPDATE SET version=version+1; END;

CREATE TRIGGER c_match_dirty_account_delete AFTER DELETE ON oa_operators
 BEGIN UPDATE c_card_match_epoch SET version=version+1 WHERE id=1;
 INSERT INTO c_card_match_generations(employee_email,version) VALUES(lower(OLD.email),1) ON CONFLICT(employee_email) DO UPDATE SET version=version+1; END;
