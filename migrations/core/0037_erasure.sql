-- Personal-data erasure (ERASURE-001). History stays permanent except inside an
-- erasure: its batch names the person here first and clears it last, in one
-- transaction, so only that batch may rewrite their address to the opaque
-- "Former member" label, delete their own comments and the reminders sent to them.
-- Receipt bytes, hashes, sizes, names and upload times stay permanent always.
CREATE TABLE c_erasing (email TEXT PRIMARY KEY);
DROP TRIGGER c_receipts_keep_bytes;
CREATE TRIGGER c_receipts_keep_bytes BEFORE UPDATE OF bytes, sha256, size, name, uploaded_at ON c_receipts
BEGIN SELECT RAISE(ABORT, 'receipt evidence is permanent'); END;
CREATE TRIGGER c_receipts_keep_uploader BEFORE UPDATE OF uploaded_by ON c_receipts WHEN NOT EXISTS(SELECT 1 FROM c_erasing)
BEGIN SELECT RAISE(ABORT, 'receipt evidence is permanent'); END;
DROP TRIGGER c_revisions_append_only;
CREATE TRIGGER c_revisions_append_only BEFORE UPDATE ON c_revisions WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_decisions_append_only;
CREATE TRIGGER c_decisions_append_only BEFORE UPDATE ON c_decisions WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_events_append_only;
CREATE TRIGGER c_events_append_only BEFORE UPDATE ON c_events WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT, 'history is permanent'); END;
DROP TRIGGER c_comments_frozen;
CREATE TRIGGER c_comments_frozen BEFORE UPDATE ON c_comments
  WHEN NOT EXISTS(SELECT 1 FROM c_erasing) AND (EXISTS(SELECT 1 FROM c_comments r WHERE r.parent_id=OLD.id) OR NEW.id IS NOT OLD.id OR NEW.claim_id IS NOT OLD.claim_id OR NEW.item_id IS NOT OLD.item_id
    OR NEW.parent_id IS NOT OLD.parent_id OR NEW.author_email IS NOT OLD.author_email OR NEW.on_behalf_of IS NOT OLD.on_behalf_of OR NEW.asks_email IS NOT OLD.asks_email OR NEW.created_at IS NOT OLD.created_at)
  BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_comments_no_delete;
CREATE TRIGGER c_comments_no_delete BEFORE DELETE ON c_comments WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id) AND NOT EXISTS(SELECT 1 FROM c_erasing WHERE email=OLD.author_email)
BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_exception_reviews_append_only;
CREATE TRIGGER c_exception_reviews_append_only BEFORE UPDATE ON c_exception_reviews WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_audit_samples_one_finding;
CREATE TRIGGER c_audit_samples_one_finding BEFORE UPDATE ON c_audit_samples WHEN NOT EXISTS(SELECT 1 FROM c_erasing) AND (OLD.outcome IS NOT NULL OR NEW.claim_id IS NOT OLD.claim_id OR NEW.revision IS NOT OLD.revision OR NEW.ordinal IS NOT OLD.ordinal OR NEW.percent IS NOT OLD.percent OR NEW.sampled_at IS NOT OLD.sampled_at)
  BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_approval_rules_append_only;
CREATE TRIGGER c_approval_rules_append_only BEFORE UPDATE ON c_approval_rules WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_report_deliveries_append_only;
CREATE TRIGGER c_report_deliveries_append_only BEFORE UPDATE ON c_report_deliveries WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_reminders_append_only;
CREATE TRIGGER c_reminders_append_only BEFORE UPDATE ON c_reminders WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_escalations_append_only;
CREATE TRIGGER c_escalations_append_only BEFORE UPDATE ON c_escalations WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_budgets_append_only;
CREATE TRIGGER c_budgets_append_only BEFORE UPDATE ON c_budgets WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_budget_alerts_append_only;
CREATE TRIGGER c_budget_alerts_append_only BEFORE UPDATE ON c_budget_alerts WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_reminders_no_delete;
CREATE TRIGGER c_reminders_no_delete BEFORE DELETE ON c_reminders WHEN NOT EXISTS(SELECT 1 FROM c_reminder_items r JOIN c_expiring e ON e.target=r.claim_id WHERE r.key=OLD.key) AND NOT EXISTS(SELECT 1 FROM c_reminder_items r JOIN c_erasing x ON x.email=r.person WHERE r.key=OLD.key)
BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_escalations_no_delete;
CREATE TRIGGER c_escalations_no_delete BEFORE DELETE ON c_escalations WHEN NOT EXISTS(SELECT 1 FROM c_reminder_items r JOIN c_expiring e ON e.target=r.claim_id WHERE r.key=OLD.key) AND NOT EXISTS(SELECT 1 FROM c_reminder_items r JOIN c_erasing x ON x.email=r.person WHERE r.key=OLD.key)
BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
