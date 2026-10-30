-- Corrections leave submitted evidence intact. Batch selections survive removal.
CREATE TABLE c_coding_corrections (
 id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, revision INTEGER NOT NULL,
 item_id TEXT NOT NULL, allocation INTEGER NOT NULL CHECK(allocation>=0),
 sequence INTEGER NOT NULL CHECK(sequence>0),
 before_code TEXT NOT NULL, after_code TEXT NOT NULL CHECK(length(after_code)>0),
 reason TEXT NOT NULL CHECK(length(trim(reason))>0), actor_email TEXT NOT NULL,
 on_behalf_of TEXT, at TEXT NOT NULL,
 UNIQUE(claim_id,revision,item_id,allocation,sequence)
);
CREATE TRIGGER c_coding_corrections_fixed BEFORE UPDATE ON c_coding_corrections WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'coding correction history is permanent'); END;
CREATE TRIGGER c_coding_corrections_kept BEFORE DELETE ON c_coding_corrections WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id) BEGIN SELECT RAISE(ABORT,'coding correction history is permanent'); END;
CREATE TABLE c_batch_coding (
 batch_id TEXT NOT NULL, claim_id TEXT NOT NULL, revision INTEGER NOT NULL,
 item_id TEXT NOT NULL, allocation INTEGER NOT NULL, correction_id TEXT,
 account_code TEXT NOT NULL,
 PRIMARY KEY(batch_id,claim_id,revision,item_id,allocation)
);
CREATE TRIGGER c_batch_coding_fixed BEFORE UPDATE ON c_batch_coding BEGIN SELECT RAISE(ABORT,'batch coding selection is permanent'); END;
CREATE TRIGGER c_batch_coding_kept BEFORE DELETE ON c_batch_coding WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id OR target=OLD.batch_id) BEGIN SELECT RAISE(ABORT,'batch coding selection is permanent'); END;
-- Native qualification of eligibility only; provider close and reversal are separate duties.
CREATE TABLE c_accounting_periods (
 ledger TEXT NOT NULL, start_on TEXT NOT NULL, end_on TEXT NOT NULL, closed_at TEXT,
 PRIMARY KEY(ledger,start_on,end_on), CHECK(start_on<=end_on)
);
