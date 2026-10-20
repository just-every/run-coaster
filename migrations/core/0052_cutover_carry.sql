-- Durable opaque source reservations survive import undo and financial retention.
-- No personal fields or imported bytes are duplicated here.
CREATE TABLE c_cutover_items (
  source_key TEXT PRIMARY KEY CHECK (length(source_key) = 64),
  claim_id TEXT NOT NULL,
  item_id TEXT NOT NULL UNIQUE
);
CREATE TABLE c_cutover_reports (
  source_key TEXT PRIMARY KEY CHECK (length(source_key) = 64),
  claim_id TEXT NOT NULL UNIQUE
);
CREATE TRIGGER c_cutover_items_no_update BEFORE UPDATE ON c_cutover_items BEGIN SELECT RAISE(ABORT, 'cutover reservation is permanent'); END;
CREATE TRIGGER c_cutover_items_no_delete BEFORE DELETE ON c_cutover_items BEGIN SELECT RAISE(ABORT, 'cutover reservation is permanent'); END;
CREATE TRIGGER c_cutover_reports_no_update BEFORE UPDATE ON c_cutover_reports BEGIN SELECT RAISE(ABORT, 'cutover reservation is permanent'); END;
CREATE TRIGGER c_cutover_reports_no_delete BEFORE DELETE ON c_cutover_reports BEGIN SELECT RAISE(ABORT, 'cutover reservation is permanent'); END;
