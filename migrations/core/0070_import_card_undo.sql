-- MOVE-001 can reverse only an unchanged imported assignment with no charge.
-- No public door writes this transaction-scoped capability; archives must be empty.
CREATE TABLE c_import_card_undo(id TEXT PRIMARY KEY);
DROP TRIGGER c_cards_no_delete;
CREATE TRIGGER c_cards_no_delete BEFORE DELETE ON c_cards
WHEN NOT EXISTS(SELECT 1 FROM c_import_card_undo u JOIN c_import_targets t ON t.kind='card' AND t.id=u.id WHERE u.id=OLD.id)
 OR EXISTS(SELECT 1 FROM c_card_charges ch WHERE ch.card_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'a card record is permanent outside an unused import undo'); END;
