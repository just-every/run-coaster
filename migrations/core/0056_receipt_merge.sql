-- CAPTURE-004: merging a duplicate is a second terminal private disposition beside discard.
-- The merged original keeps its bytes and history; only its own line names the survivor, which is never written to.
CREATE TABLE c_capture_lifecycle_next (
  receipt_id TEXT NOT NULL REFERENCES c_capture_receipts(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  kind TEXT NOT NULL CHECK (kind IN ('discarded','merged')),
  reason TEXT NOT NULL,
  survivor_id TEXT REFERENCES c_capture_receipts(id),
  at TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  on_behalf_of TEXT,
  channel TEXT NOT NULL CHECK (channel = 'app'),
  PRIMARY KEY (receipt_id,sequence),
  CHECK ((kind = 'merged') = (survivor_id IS NOT NULL) AND (survivor_id IS NULL OR survivor_id <> receipt_id))
);
INSERT INTO c_capture_lifecycle_next(receipt_id,sequence,kind,reason,at,actor_email,on_behalf_of,channel)
  SELECT receipt_id,sequence,kind,reason,at,actor_email,on_behalf_of,channel FROM c_capture_lifecycle;
DROP TABLE c_capture_lifecycle;
ALTER TABLE c_capture_lifecycle_next RENAME TO c_capture_lifecycle;
CREATE UNIQUE INDEX c_capture_lifecycle_terminal ON c_capture_lifecycle(receipt_id) WHERE kind IN ('discarded','merged');

CREATE TRIGGER c_capture_lifecycle_keep_facts BEFORE UPDATE OF receipt_id,sequence,kind,survivor_id,at,channel ON c_capture_lifecycle
BEGIN SELECT RAISE(ABORT,'receipt lifecycle is permanent'); END;
CREATE TRIGGER c_capture_lifecycle_keep_identity BEFORE UPDATE OF actor_email,on_behalf_of,reason ON c_capture_lifecycle WHEN NOT EXISTS(SELECT 1 FROM c_capture_erasing)
BEGIN SELECT RAISE(ABORT,'receipt lifecycle is permanent'); END;
CREATE TRIGGER c_capture_lifecycle_no_delete BEFORE DELETE ON c_capture_lifecycle
BEGIN SELECT RAISE(ABORT,'receipt lifecycle is permanent'); END;
-- Expanded replacements are retained, never truncated. Only an identical-hash merge may carry no reason.
CREATE TRIGGER c_capture_lifecycle_reason_insert BEFORE INSERT ON c_capture_lifecycle
WHEN typeof(NEW.reason)<>'text' OR length(CAST(NEW.reason AS BLOB)) NOT BETWEEN (CASE NEW.kind WHEN 'merged' THEN 0 ELSE 1 END) AND 22000
BEGIN SELECT RAISE(ABORT,'receipt reason exceeds its byte bound'); END;
CREATE TRIGGER c_capture_lifecycle_reason_update BEFORE UPDATE OF reason ON c_capture_lifecycle
WHEN NOT EXISTS(SELECT 1 FROM c_capture_erasing) OR OLD.reason=''
  OR typeof(NEW.reason)<>'text' OR length(CAST(NEW.reason AS BLOB)) NOT BETWEEN 1 AND 22000
BEGIN SELECT RAISE(ABORT,'receipt reason is permanent outside bounded erasure'); END;
-- A survivor is the same employee's own original that has no terminal disposition yet; a merge without
-- identical SHA-256 states its reason.
CREATE TRIGGER c_capture_lifecycle_merge_insert BEFORE INSERT ON c_capture_lifecycle
WHEN NEW.kind='merged' AND NOT EXISTS(
  SELECT 1 FROM c_capture_receipts d JOIN c_capture_receipts s ON s.owner_email=d.owner_email AND s.id=NEW.survivor_id
  WHERE d.id=NEW.receipt_id AND NEW.at>=s.uploaded_at AND (NEW.reason<>'' OR s.sha256=d.sha256)
    AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle t WHERE t.receipt_id=s.id AND t.kind IN ('discarded','merged')))
BEGIN SELECT RAISE(ABORT,'a merge needs its own open survivor and, unless identical, a reason'); END;
