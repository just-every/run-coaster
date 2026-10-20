-- CAPTURE-004: terminal private disposition, independent of reader processing.
CREATE TABLE c_capture_lifecycle (
  receipt_id TEXT NOT NULL REFERENCES c_capture_receipts(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  kind TEXT NOT NULL CHECK (kind = 'discarded'),
  reason TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  on_behalf_of TEXT,
  channel TEXT NOT NULL CHECK (channel = 'app'),
  PRIMARY KEY (receipt_id,sequence),
  UNIQUE (receipt_id,kind)
);
CREATE TRIGGER c_capture_lifecycle_keep_facts BEFORE UPDATE OF receipt_id,sequence,kind,at,channel ON c_capture_lifecycle
BEGIN SELECT RAISE(ABORT,'receipt lifecycle is permanent'); END;
CREATE TRIGGER c_capture_lifecycle_keep_identity BEFORE UPDATE OF actor_email,on_behalf_of,reason ON c_capture_lifecycle WHEN NOT EXISTS(SELECT 1 FROM c_capture_erasing)
BEGIN SELECT RAISE(ABORT,'receipt lifecycle is permanent'); END;
CREATE TRIGGER c_capture_lifecycle_no_delete BEFORE DELETE ON c_capture_lifecycle
BEGIN SELECT RAISE(ABORT,'receipt lifecycle is permanent'); END;
