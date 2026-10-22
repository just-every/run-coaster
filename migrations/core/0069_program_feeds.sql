-- Consented, read-only SFTP pick-up. Authentication material is installation-private.
CREATE TABLE c_program_feeds (
 id TEXT PRIMARY KEY, issuer TEXT NOT NULL, credentials_sealed TEXT,
 mapping TEXT NOT NULL CHECK(json_valid(mapping)), category_id TEXT NOT NULL,
 cost_centre TEXT NOT NULL DEFAULT '', interval_minutes INTEGER NOT NULL CHECK(interval_minutes BETWEEN 60 AND 1440),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), version INTEGER NOT NULL,
 next_run_at INTEGER NOT NULL DEFAULT 0, last_success_at TEXT, last_error TEXT,
 connected_by TEXT NOT NULL, connected_at TEXT NOT NULL, disconnected_at TEXT,
 lease_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE c_program_deliveries (
 id TEXT PRIMARY KEY, feed_id TEXT NOT NULL REFERENCES c_program_feeds(id),
 name TEXT NOT NULL, issuer_sequence TEXT NOT NULL, sha256 TEXT NOT NULL,
 file_id TEXT REFERENCES c_statement_files(id), charges INTEGER NOT NULL,
 received_at TEXT NOT NULL, UNIQUE(feed_id,issuer_sequence), UNIQUE(feed_id,name,sha256)
);
CREATE TRIGGER c_program_deliveries_immutable BEFORE UPDATE ON c_program_deliveries BEGIN SELECT RAISE(ABORT,'program delivery history is permanent'); END;
CREATE TRIGGER c_program_deliveries_no_delete BEFORE DELETE ON c_program_deliveries BEGIN SELECT RAISE(ABORT,'program delivery history is permanent'); END;
ALTER TABLE c_statement_files ADD COLUMN source TEXT NOT NULL DEFAULT 'statement-file' CHECK(source IN ('statement-file','program-feed'));
CREATE TRIGGER c_statement_source_immutable BEFORE UPDATE OF source ON c_statement_files BEGIN SELECT RAISE(ABORT,'delivery provenance is permanent'); END;
