-- Finance exception queue and audit sampling (POLICY-003). Finance reviews each
-- open exception once with a note; approvals are sampled systematically at the
-- percentage finance sets, and each sample takes one recorded finding.
CREATE TABLE c_exception_reviews (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES c_claims(id),
  revision INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  code TEXT NOT NULL,
  note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 1000),
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  UNIQUE (claim_id, revision, item_id, code)
);
CREATE TRIGGER c_exception_reviews_append_only BEFORE UPDATE ON c_exception_reviews BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
CREATE TRIGGER c_exception_reviews_no_delete BEFORE DELETE ON c_exception_reviews BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;

ALTER TABLE c_business ADD COLUMN audit_sample_percent INTEGER CHECK (audit_sample_percent IS NULL OR audit_sample_percent BETWEEN 1 AND 100);

CREATE TABLE c_audit_samples (
  claim_id TEXT NOT NULL REFERENCES c_claims(id),
  revision INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  percent INTEGER NOT NULL,
  sampled_at TEXT NOT NULL,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('clean', 'issue')),
  finding TEXT,
  finding_by TEXT,
  finding_at TEXT,
  PRIMARY KEY (claim_id, revision)
);
CREATE TRIGGER c_audit_samples_one_finding BEFORE UPDATE ON c_audit_samples WHEN OLD.outcome IS NOT NULL OR NEW.claim_id IS NOT OLD.claim_id OR NEW.revision IS NOT OLD.revision OR NEW.ordinal IS NOT OLD.ordinal OR NEW.percent IS NOT OLD.percent OR NEW.sampled_at IS NOT OLD.sampled_at
  BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
CREATE TRIGGER c_audit_samples_no_delete BEFORE DELETE ON c_audit_samples BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
