-- CAPTURE-001: private, unattached originals. Existing claim receipts retain
-- their original BLOB storage and claim access rules.
CREATE TABLE c_capture_erasing (email TEXT PRIMARY KEY);

CREATE TABLE c_capture_receipts (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/webp','image/heic','application/pdf')),
  size INTEGER NOT NULL CHECK (size > 0 AND size <= 10000000),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  object_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('upload','camera')),
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL
);
CREATE INDEX c_capture_receipts_owner ON c_capture_receipts(owner_email,uploaded_at,id);
CREATE TRIGGER c_capture_receipts_keep_evidence BEFORE UPDATE OF id,name,media_type,size,sha256,object_key,source,uploaded_at ON c_capture_receipts
BEGIN SELECT RAISE(ABORT,'receipt evidence is permanent'); END;
CREATE TRIGGER c_capture_receipts_keep_identity BEFORE UPDATE OF owner_email,uploaded_by ON c_capture_receipts WHEN NOT EXISTS(SELECT 1 FROM c_capture_erasing)
BEGIN SELECT RAISE(ABORT,'receipt evidence is permanent'); END;
CREATE TRIGGER c_capture_receipts_no_delete BEFORE DELETE ON c_capture_receipts
BEGIN SELECT RAISE(ABORT,'receipt evidence is permanent'); END;

-- Inbox history is private too: global claim audit readers must not gain
-- access to an employee's unattached originals or their filenames.
CREATE TABLE c_capture_receipt_events (
  receipt_id TEXT NOT NULL REFERENCES c_capture_receipts(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  state TEXT NOT NULL CHECK (state IN ('received','reading','read','needs-attention')),
  reason TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  on_behalf_of TEXT,
  channel TEXT NOT NULL CHECK (channel = 'app'),
  PRIMARY KEY (receipt_id,sequence)
);
CREATE TRIGGER c_capture_receipt_events_append_only BEFORE UPDATE OF receipt_id,sequence,state,reason,at,channel ON c_capture_receipt_events
BEGIN SELECT RAISE(ABORT,'receipt history is permanent'); END;
CREATE TRIGGER c_capture_receipt_events_keep_identity BEFORE UPDATE OF actor_email,on_behalf_of ON c_capture_receipt_events WHEN NOT EXISTS(SELECT 1 FROM c_capture_erasing)
BEGIN SELECT RAISE(ABORT,'receipt history is permanent'); END;
CREATE TRIGGER c_capture_receipt_events_no_delete BEFORE DELETE ON c_capture_receipt_events
BEGIN SELECT RAISE(ABORT,'receipt history is permanent'); END;
