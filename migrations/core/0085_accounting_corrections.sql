-- Submitted evidence stays immutable. Native account corrections are a separate append-only overlay.
CREATE TABLE c_accounting_corrections (
 id TEXT PRIMARY KEY, claim_id TEXT NOT NULL REFERENCES c_claims(id), revision INTEGER NOT NULL,
 item_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0),
 before_json TEXT NOT NULL CHECK(json_valid(before_json)), after_json TEXT NOT NULL CHECK(json_valid(after_json)),
 reason TEXT NOT NULL, actor_email TEXT NOT NULL, on_behalf_of TEXT, at TEXT NOT NULL,
 UNIQUE(claim_id,revision,item_id,sequence)
);
CREATE TRIGGER c_accounting_corrections_fixed BEFORE UPDATE ON c_accounting_corrections WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'accounting correction history is permanent'); END;
CREATE TRIGGER c_accounting_corrections_kept BEFORE DELETE ON c_accounting_corrections WHEN NOT EXISTS(SELECT 1 FROM c_erasing) AND NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id) BEGIN SELECT RAISE(ABORT,'accounting correction history is permanent'); END;
-- Keep the exact selections even after removal; retained selections alone are never a posting.
CREATE TABLE c_batch_coding (
 batch_id TEXT NOT NULL REFERENCES c_batches(id), claim_id TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL,
 selections TEXT NOT NULL CHECK(json_valid(selections)), PRIMARY KEY(batch_id,claim_id,generation)
);
CREATE TRIGGER c_batch_coding_fixed BEFORE UPDATE ON c_batch_coding WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'batch coding evidence is permanent'); END;
CREATE TRIGGER c_batch_coding_kept BEFORE DELETE ON c_batch_coding WHEN NOT EXISTS(SELECT 1 FROM c_erasing) AND NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id OR target=OLD.batch_id) BEGIN SELECT RAISE(ABORT,'batch coding evidence is permanent'); END;
