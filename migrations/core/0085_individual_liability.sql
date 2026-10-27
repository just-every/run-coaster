-- FEED-006: liability is immutable import provenance; personal classification freezes with each revision.
ALTER TABLE c_program_feeds ADD COLUMN liability TEXT NOT NULL DEFAULT 'company' CHECK(liability IN ('company','individual'));
ALTER TABLE c_card_charges ADD COLUMN liability TEXT NOT NULL DEFAULT 'company' CHECK(liability IN ('company','individual'));
ALTER TABLE c_card_charges ADD COLUMN program_id TEXT;
ALTER TABLE c_card_charge_undo_history ADD COLUMN liability TEXT NOT NULL DEFAULT 'company' CHECK(liability IN ('company','individual'));
ALTER TABLE c_card_charge_undo_history ADD COLUMN program_id TEXT;
ALTER TABLE c_items ADD COLUMN card_liability TEXT NOT NULL DEFAULT 'company' CHECK(card_liability IN ('company','individual'));
ALTER TABLE c_items ADD COLUMN card_personal INTEGER NOT NULL DEFAULT 0 CHECK(card_personal IN (0,1));
CREATE TRIGGER c_program_liability_keep BEFORE UPDATE OF liability ON c_program_feeds
 WHEN NEW.liability IS NOT OLD.liability BEGIN SELECT RAISE(ABORT,'program liability is immutable'); END;
CREATE TRIGGER c_charge_liability_keep BEFORE UPDATE OF liability,program_id ON c_card_charges
 WHEN NEW.liability IS NOT OLD.liability OR NEW.program_id IS NOT OLD.program_id BEGIN SELECT RAISE(ABORT,'charge liability is immutable'); END;
CREATE TRIGGER c_individual_charge_owner_keep BEFORE UPDATE OF employee_email,claim_id ON c_card_charges
 WHEN OLD.liability='individual' AND NOT EXISTS(SELECT 1 FROM c_erasing)
 AND (NEW.employee_email IS NOT OLD.employee_email OR NEW.claim_id IS NOT OLD.claim_id)
 BEGIN SELECT RAISE(ABORT,'individual liability remains with its original cardholder'); END;
CREATE TRIGGER c_item_liability_insert BEFORE INSERT ON c_items WHEN
 (NEW.card_charge_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM c_card_charges ch WHERE ch.id=NEW.card_charge_id AND ch.liability=NEW.card_liability))
 OR (NEW.card_personal=1 AND (NEW.card_charge_id IS NULL OR NEW.card_liability<>'individual'))
 BEGIN SELECT RAISE(ABORT,'card liability must match its immutable charge'); END;
CREATE TRIGGER c_item_liability_update BEFORE UPDATE OF card_liability,card_personal ON c_items WHEN
 NEW.card_liability IS NOT OLD.card_liability OR
 (NEW.card_personal IS NOT OLD.card_personal AND (OLD.card_liability<>'individual' OR OLD.card_charge_id IS NULL OR NOT EXISTS(SELECT 1 FROM c_claims c WHERE c.id=OLD.claim_id AND c.status IN ('draft','returned'))))
 BEGIN SELECT RAISE(ABORT,'submitted card classification is frozen'); END;
DROP TRIGGER c_card_charge_undo_capture;
CREATE TRIGGER c_card_charge_undo_capture BEFORE DELETE ON c_card_charges
 BEGIN INSERT INTO c_card_charge_undo_history(id,file_id,card_id,employee_email,transaction_key,posted_on,transaction_on,descriptor,memo,amount_minor,currency,original_minor,original_currency,item_id,category_id,created_at,claim_id,liability,program_id) VALUES(OLD.id,OLD.file_id,OLD.card_id,OLD.employee_email,OLD.transaction_key,OLD.posted_on,OLD.transaction_on,OLD.descriptor,OLD.memo,OLD.amount_minor,OLD.currency,OLD.original_minor,OLD.original_currency,OLD.item_id,OLD.category_id,OLD.created_at,OLD.claim_id,OLD.liability,OLD.program_id); END;
