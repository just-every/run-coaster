-- Account codes are overlays on an immutable submitted revision, never edits to it.
CREATE TABLE c_account_corrections (
 id TEXT PRIMARY KEY,
 claim_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 item_id TEXT NOT NULL,
 allocation_position INTEGER NOT NULL CHECK(allocation_position>=0),
 sequence INTEGER NOT NULL CHECK(sequence>0),
 before_account TEXT NOT NULL,
 after_account TEXT NOT NULL CHECK(length(trim(after_account)) BETWEEN 1 AND 100),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 22000),
 actor_email TEXT NOT NULL,
 acting_for TEXT,
 at TEXT NOT NULL,
 UNIQUE(claim_id,sequence),
 FOREIGN KEY(claim_id,revision) REFERENCES c_revisions(claim_id,revision),
 CHECK(before_account<>after_account)
);
CREATE TRIGGER c_account_corrections_fixed BEFORE UPDATE ON c_account_corrections
 WHEN NOT EXISTS(SELECT 1 FROM c_erasing)
 BEGIN SELECT RAISE(ABORT,'account correction history is permanent'); END;
CREATE TRIGGER c_account_corrections_kept BEFORE DELETE ON c_account_corrections
 WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id)
 BEGIN SELECT RAISE(ABORT,'account correction history is permanent'); END;

-- A removed draft batch still retains the coding selection it originally froze.
CREATE TABLE c_batch_coding (
 batch_id TEXT NOT NULL REFERENCES c_batches(id),
 claim_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 correction_sequence INTEGER NOT NULL CHECK(correction_sequence>=0),
 PRIMARY KEY(batch_id,claim_id),
 FOREIGN KEY(claim_id,revision) REFERENCES c_revisions(claim_id,revision)
);
CREATE TRIGGER c_batch_coding_fixed BEFORE UPDATE ON c_batch_coding
 BEGIN SELECT RAISE(ABORT,'batch coding selection is permanent'); END;
CREATE TRIGGER c_batch_coding_kept BEFORE DELETE ON c_batch_coding
 WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id)
 BEGIN SELECT RAISE(ABORT,'batch coding selection is permanent'); END;
