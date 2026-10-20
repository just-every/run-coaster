-- CAPTURE-004 / ERASURE-001: expanded replacements are retained, never truncated.
CREATE TRIGGER c_capture_lifecycle_reason_insert BEFORE INSERT ON c_capture_lifecycle
WHEN NEW.kind='discarded' AND (typeof(NEW.reason)<>'text' OR length(CAST(NEW.reason AS BLOB)) NOT BETWEEN 1 AND 22000)
BEGIN SELECT RAISE(ABORT,'receipt reason exceeds its byte bound'); END;
CREATE TRIGGER c_capture_lifecycle_reason_update BEFORE UPDATE OF reason ON c_capture_lifecycle
WHEN NOT EXISTS(SELECT 1 FROM c_capture_erasing) OR OLD.kind<>'discarded'
  OR typeof(NEW.reason)<>'text' OR length(CAST(NEW.reason AS BLOB)) NOT BETWEEN 1 AND 22000
BEGIN SELECT RAISE(ABORT,'receipt reason is permanent outside bounded erasure'); END;
