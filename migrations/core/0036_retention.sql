-- Record retention and legal hold (RETAIN-001). The owner sets how many years
-- paid and rejected claims are kept; the hourly run proposes those past it and
-- nothing is removed until the owner confirms. Expiry leaves a receipt, and the
-- exact-expense keys of expired claims stay (as SHA-256) so a receipt is never
-- reimbursed twice. A legal hold on a person, the business or an expense-date
-- period blocks expiry (and ERASURE-001) until the owner releases it.
ALTER TABLE c_business ADD COLUMN retention_years INTEGER NOT NULL DEFAULT 7 CHECK (retention_years BETWEEN 1 AND 30);
CREATE TABLE c_legal_holds (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('person', 'business', 'period')),
  member_email TEXT,
  from_day TEXT,
  to_day TEXT,
  reason TEXT NOT NULL,
  placed_by TEXT NOT NULL,
  placed_at TEXT NOT NULL,
  released_by TEXT,
  released_at TEXT,
  CHECK ((scope = 'person') = (member_email IS NOT NULL)),
  CHECK ((scope = 'period') = (from_day IS NOT NULL AND to_day IS NOT NULL AND from_day <= to_day))
);
CREATE TABLE c_expiry_proposals (
  id TEXT PRIMARY KEY,
  proposed_at TEXT NOT NULL,
  retention_years INTEGER NOT NULL,
  claims TEXT NOT NULL CHECK (json_valid(claims)),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed')),
  confirmed_by TEXT,
  confirmed_at TEXT,
  receipt TEXT CHECK (receipt IS NULL OR json_valid(receipt))
);
CREATE TABLE c_expired_keys (
  key_sha256 TEXT PRIMARY KEY CHECK (length(key_sha256) = 64),
  claim_number INTEGER NOT NULL,
  expired_at TEXT NOT NULL
);

-- History stays permanent except inside a confirmed expiry: the expiry batch names
-- the claims and batch it removes here first and clears it last, in one transaction.
CREATE TABLE c_expiring (target TEXT PRIMARY KEY);
DROP TRIGGER c_receipts_no_delete;
CREATE TRIGGER c_receipts_no_delete BEFORE DELETE ON c_receipts WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id)
BEGIN SELECT RAISE(ABORT, 'receipt evidence is permanent'); END;
DROP TRIGGER c_revisions_no_delete;
CREATE TRIGGER c_revisions_no_delete BEFORE DELETE ON c_revisions WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_decisions_no_delete;
CREATE TRIGGER c_decisions_no_delete BEFORE DELETE ON c_decisions WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_comments_no_delete;
CREATE TRIGGER c_comments_no_delete BEFORE DELETE ON c_comments WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_exception_reviews_no_delete;
CREATE TRIGGER c_exception_reviews_no_delete BEFORE DELETE ON c_exception_reviews WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_audit_samples_no_delete;
CREATE TRIGGER c_audit_samples_no_delete BEFORE DELETE ON c_audit_samples WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_events_no_delete;
CREATE TRIGGER c_events_no_delete BEFORE DELETE ON c_events WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id OR target=OLD.batch_id) BEGIN SELECT RAISE(ABORT, 'history is permanent'); END;
DROP TRIGGER c_reminders_no_delete;
CREATE TRIGGER c_reminders_no_delete BEFORE DELETE ON c_reminders WHEN NOT EXISTS(SELECT 1 FROM c_reminder_items r JOIN c_expiring e ON e.target=r.claim_id WHERE r.key=OLD.key) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
DROP TRIGGER c_escalations_no_delete;
CREATE TRIGGER c_escalations_no_delete BEFORE DELETE ON c_escalations WHEN NOT EXISTS(SELECT 1 FROM c_reminder_items r JOIN c_expiring e ON e.target=r.claim_id WHERE r.key=OLD.key) BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
