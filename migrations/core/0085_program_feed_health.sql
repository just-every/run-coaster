-- Daily expectations are explicit; legacy connections make no coverage claim.
ALTER TABLE c_program_feeds ADD COLUMN delivery_time TEXT;
ALTER TABLE c_program_feeds ADD COLUMN delivery_timezone TEXT;
ALTER TABLE c_program_feeds ADD COLUMN grace_minutes INTEGER;
ALTER TABLE c_program_feeds ADD COLUMN expected_from TEXT;
ALTER TABLE c_program_deliveries ADD COLUMN coverage_date TEXT;
CREATE TABLE c_program_health (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 feed_id TEXT NOT NULL REFERENCES c_program_feeds(id),
 delivery_date TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('missed','covered')),
 delivery_id TEXT REFERENCES c_program_deliveries(id),
 at TEXT NOT NULL,
 UNIQUE(feed_id,delivery_date,kind),
 CHECK((kind='covered' AND delivery_id IS NOT NULL) OR (kind='missed' AND delivery_id IS NULL))
);
CREATE TRIGGER c_program_health_no_update BEFORE UPDATE ON c_program_health BEGIN SELECT RAISE(ABORT,'program health history is permanent'); END;
CREATE TRIGGER c_program_health_no_delete BEFORE DELETE ON c_program_health BEGIN SELECT RAISE(ABORT,'program health history is permanent'); END;
