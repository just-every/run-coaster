-- CAPTURE-003: consented private reading and immutable human corrections.
CREATE TABLE c_receipt_reading_settings (
 version INTEGER PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
 threshold REAL NOT NULL CHECK(threshold>=0.9 AND threshold<=1), model TEXT NOT NULL,
 set_by TEXT NOT NULL, set_at TEXT NOT NULL
);
INSERT INTO c_receipt_reading_settings VALUES(0,0,0.95,'','installation','1970-01-01T00:00:00.000Z');
CREATE TABLE c_receipt_readings (
 receipt_id TEXT NOT NULL REFERENCES c_capture_receipts(id), sequence INTEGER NOT NULL CHECK(sequence>0),
 kind TEXT NOT NULL CHECK(kind IN('started','read','failed','corrected')),
 attempt_id TEXT NOT NULL, settings_version INTEGER NOT NULL REFERENCES c_receipt_reading_settings(version),
 original_sha256 TEXT NOT NULL, model TEXT NOT NULL,
 fields_json TEXT NOT NULL CHECK(json_valid(fields_json)), error_code TEXT NOT NULL DEFAULT '',
 usage_json TEXT NOT NULL CHECK(json_valid(usage_json)),
 actor_email TEXT NOT NULL, on_behalf_of TEXT, at TEXT NOT NULL,
 PRIMARY KEY(receipt_id,sequence)
);
CREATE TABLE c_receipt_reading_match_defaults (
 employee_email TEXT NOT NULL, version INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
 set_at TEXT NOT NULL, PRIMARY KEY(employee_email,version)
);
CREATE TRIGGER c_receipt_reading_settings_immutable BEFORE UPDATE ON c_receipt_reading_settings WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'reader settings versions are permanent'); END;
CREATE TRIGGER c_receipt_reading_settings_no_delete BEFORE DELETE ON c_receipt_reading_settings BEGIN SELECT RAISE(ABORT,'reader settings versions are permanent'); END;
CREATE TRIGGER c_receipt_readings_immutable BEFORE UPDATE ON c_receipt_readings WHEN NOT EXISTS(SELECT 1 FROM c_capture_erasing) BEGIN SELECT RAISE(ABORT,'original readings and corrections are permanent'); END;
CREATE TRIGGER c_receipt_readings_no_delete BEFORE DELETE ON c_receipt_readings BEGIN SELECT RAISE(ABORT,'original readings and corrections are permanent'); END;
CREATE TRIGGER c_receipt_reading_defaults_immutable BEFORE UPDATE ON c_receipt_reading_match_defaults WHEN NOT EXISTS(SELECT 1 FROM c_capture_erasing) BEGIN SELECT RAISE(ABORT,'reader consent versions are permanent'); END;
CREATE TRIGGER c_receipt_reading_defaults_no_delete BEFORE DELETE ON c_receipt_reading_match_defaults WHEN NOT EXISTS(SELECT 1 FROM c_capture_erasing) BEGIN SELECT RAISE(ABORT,'reader consent versions are permanent'); END;
