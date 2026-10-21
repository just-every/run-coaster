-- CAPTURE-004: finance-confirmed, off-by-default draft preparation; no duplicate R2 object or inferred amount.
CREATE TABLE c_capture_window (
 id INTEGER PRIMARY KEY CHECK(id=1),
 days INTEGER CHECK(days BETWEEN 1 AND 90),
 version INTEGER NOT NULL CHECK(version>=0)
);
INSERT INTO c_capture_window(id,days,version) VALUES(1,NULL,0);
-- Reservation survives claim retention so replay never makes a second draft from the original.
CREATE TABLE c_capture_cash_drafts (
 receipt_id TEXT PRIMARY KEY REFERENCES c_capture_receipts(id),
 claim_id TEXT NOT NULL UNIQUE,
 expense_date TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TRIGGER c_capture_cash_drafts_no_update BEFORE UPDATE ON c_capture_cash_drafts
BEGIN SELECT RAISE(ABORT,'cash draft reservation is permanent'); END;
CREATE TRIGGER c_capture_cash_drafts_no_delete BEFORE DELETE ON c_capture_cash_drafts
BEGIN SELECT RAISE(ABORT,'cash draft reservation is permanent'); END;
