-- CAPTURE-004: claim aliases reference one immutable R2 original; legacy BLOB receipts remain unchanged.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE c_receipts_next (
  id TEXT PRIMARY KEY,
  claim_id TEXT REFERENCES c_claims(id),
  proposal_id TEXT REFERENCES c_proposals(id),
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  bytes BLOB NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('upload', 'camera', 'agent')),
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  capture_receipt_id TEXT REFERENCES c_capture_receipts(id),
  CHECK ((capture_receipt_id IS NULL AND length(bytes)=size) OR (capture_receipt_id IS NOT NULL AND length(bytes)=0))
);
INSERT INTO c_receipts_next(id,claim_id,proposal_id,owner_email,name,media_type,size,sha256,bytes,source,uploaded_by,uploaded_at) SELECT id,claim_id,proposal_id,owner_email,name,media_type,size,sha256,bytes,source,uploaded_by,uploaded_at FROM c_receipts;
-- SQLite cannot drop a referenced parent even under deferred checks. Preserve
-- every expense link, clear it only inside this migration, then restore it verbatim.
CREATE TABLE c_capture_upgrade_links AS SELECT id,receipt_id FROM c_items WHERE receipt_id IS NOT NULL;
UPDATE c_items SET receipt_id=NULL WHERE receipt_id IS NOT NULL;
DROP TRIGGER c_receipts_no_delete;
DROP TABLE c_receipts;
ALTER TABLE c_receipts_next RENAME TO c_receipts;
UPDATE c_items SET receipt_id=(SELECT receipt_id FROM c_capture_upgrade_links WHERE id=c_items.id) WHERE id IN (SELECT id FROM c_capture_upgrade_links);
DROP TABLE c_capture_upgrade_links;
CREATE INDEX c_receipts_claim ON c_receipts(claim_id);
CREATE INDEX c_receipts_hash ON c_receipts(sha256);
CREATE TRIGGER c_receipts_keep_bytes BEFORE UPDATE OF bytes,sha256,size,name,uploaded_at,capture_receipt_id ON c_receipts
BEGIN SELECT RAISE(ABORT,'receipt evidence is permanent'); END;
CREATE TRIGGER c_receipts_keep_uploader BEFORE UPDATE OF uploaded_by ON c_receipts WHEN NOT EXISTS(SELECT 1 FROM c_erasing)
BEGIN SELECT RAISE(ABORT,'receipt evidence is permanent'); END;
CREATE TRIGGER c_receipts_no_delete BEFORE DELETE ON c_receipts WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.claim_id)
BEGIN SELECT RAISE(ABORT,'receipt evidence is permanent'); END;
CREATE TRIGGER c_receipts_capture_insert BEFORE INSERT ON c_receipts WHEN NEW.capture_receipt_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM c_capture_receipts r WHERE r.id=NEW.capture_receipt_id AND r.owner_email=NEW.owner_email AND r.name=NEW.name
 AND r.media_type=NEW.media_type AND r.size=NEW.size AND r.sha256=NEW.sha256 AND r.source=NEW.source AND r.uploaded_by=NEW.uploaded_by AND r.uploaded_at=NEW.uploaded_at)
BEGIN SELECT RAISE(ABORT,'receipt alias must preserve original evidence'); END;
CREATE TABLE c_capture_lifecycle_next (
  receipt_id TEXT NOT NULL REFERENCES c_capture_receipts(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  kind TEXT NOT NULL CHECK (kind IN ('discarded','merged','attached','detached')),
  reason TEXT NOT NULL,
  survivor_id TEXT REFERENCES c_capture_receipts(id),
  claim_id TEXT,
  item_id TEXT,
  at TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  on_behalf_of TEXT,
  channel TEXT NOT NULL CHECK (channel = 'app'),
  PRIMARY KEY (receipt_id,sequence),
  CHECK ((kind IN ('attached','detached')) = (claim_id IS NOT NULL AND item_id IS NOT NULL)),
  CHECK ((kind = 'merged') = (survivor_id IS NOT NULL) AND (survivor_id IS NULL OR survivor_id <> receipt_id))
);
INSERT INTO c_capture_lifecycle_next(receipt_id,sequence,kind,reason,survivor_id,at,actor_email,on_behalf_of,channel)
 SELECT receipt_id,sequence,kind,reason,survivor_id,at,actor_email,on_behalf_of,channel FROM c_capture_lifecycle;
DROP TABLE c_capture_lifecycle;
ALTER TABLE c_capture_lifecycle_next RENAME TO c_capture_lifecycle;
CREATE UNIQUE INDEX c_capture_lifecycle_terminal ON c_capture_lifecycle(receipt_id) WHERE kind IN ('discarded','merged');
CREATE TRIGGER c_capture_lifecycle_keep_facts BEFORE UPDATE OF receipt_id,sequence,kind,survivor_id,claim_id,item_id,at,channel ON c_capture_lifecycle
BEGIN SELECT RAISE(ABORT,'receipt lifecycle is permanent'); END;
CREATE TRIGGER c_capture_lifecycle_keep_identity BEFORE UPDATE OF actor_email,on_behalf_of,reason ON c_capture_lifecycle WHEN NOT EXISTS(SELECT 1 FROM c_capture_erasing)
BEGIN SELECT RAISE(ABORT,'receipt lifecycle is permanent'); END;
CREATE TRIGGER c_capture_lifecycle_no_delete BEFORE DELETE ON c_capture_lifecycle
BEGIN SELECT RAISE(ABORT,'receipt lifecycle is permanent'); END;
-- Expanded replacements are retained, never truncated. Only an identical-hash merge may carry no reason.
CREATE TRIGGER c_capture_lifecycle_reason_insert BEFORE INSERT ON c_capture_lifecycle
WHEN typeof(NEW.reason)<>'text' OR length(CAST(NEW.reason AS BLOB)) NOT BETWEEN (CASE WHEN NEW.kind IN ('merged','attached','detached') THEN 0 ELSE 1 END) AND 22000
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

CREATE TRIGGER c_capture_lifecycle_sequence BEFORE INSERT ON c_capture_lifecycle
WHEN NEW.sequence<>(SELECT COALESCE(MAX(sequence),0)+1 FROM c_capture_lifecycle WHERE receipt_id=NEW.receipt_id)
 OR EXISTS(SELECT 1 FROM c_capture_lifecycle WHERE receipt_id=NEW.receipt_id AND kind IN ('discarded','merged'))
BEGIN SELECT RAISE(ABORT,'receipt lifecycle sequence is permanent'); END;
-- Disposition may never retire an original that a live expense still carries.
CREATE TRIGGER c_capture_lifecycle_open_disposition BEFORE INSERT ON c_capture_lifecycle
WHEN NEW.kind IN ('discarded','merged') AND EXISTS(
 SELECT 1 FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id WHERE a.capture_receipt_id=NEW.receipt_id
 OR (NEW.kind='merged' AND a.capture_receipt_id=NEW.survivor_id))
BEGIN SELECT RAISE(ABORT,'detach receipts before disposition'); END;
CREATE TRIGGER c_capture_lifecycle_attachment BEFORE INSERT ON c_capture_lifecycle
WHEN NEW.kind IN ('attached','detached') AND (
 NEW.reason<>'' OR NOT EXISTS(SELECT 1 FROM c_items i JOIN c_claims c ON c.id=i.claim_id JOIN c_capture_receipts r ON r.id=NEW.receipt_id
 WHERE i.id=NEW.item_id AND c.id=NEW.claim_id AND c.employee_email=r.owner_email AND c.status IN ('draft','returned') AND i.kind='receipt'
 AND ((NEW.kind='attached' AND EXISTS(SELECT 1 FROM c_receipts a WHERE a.id=i.receipt_id AND a.capture_receipt_id=r.id))
 OR (NEW.kind='detached' AND i.receipt_id IS NULL)))
 OR (NEW.kind='attached' AND COALESCE((SELECT kind FROM c_capture_lifecycle WHERE receipt_id=NEW.receipt_id ORDER BY sequence DESC LIMIT 1),'detached')<>'detached')
 OR (NEW.kind='detached' AND COALESCE((SELECT kind FROM c_capture_lifecycle WHERE receipt_id=NEW.receipt_id ORDER BY sequence DESC LIMIT 1),'')<>'attached'))
BEGIN SELECT RAISE(ABORT,'attachment needs its editable employee expense and exact transition'); END;
