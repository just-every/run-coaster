-- Web Connector credentials and live tickets never travel in an archive.
CREATE TABLE c_qbd_connection (
 id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password_hash TEXT NOT NULL,
 company TEXT NOT NULL, file_id TEXT NOT NULL, owner_id TEXT NOT NULL,
 connected_by TEXT NOT NULL, connected_at TEXT NOT NULL
);
CREATE TABLE c_qbd_tickets (
 ticket_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, request_id TEXT,
 last_request TEXT, last_result INTEGER, error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE c_qbd_catalog (
 kind TEXT NOT NULL, list_id TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL,
 PRIMARY KEY(kind,list_id)
);
CREATE TABLE c_qbd_mappings (name TEXT PRIMARY KEY, kind TEXT NOT NULL, list_id TEXT NOT NULL);
CREATE TABLE c_qbd_requests (
 id TEXT PRIMARY KEY, source TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, payload TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('pending','sent','succeeded','failed','uncertain')),
 message TEXT NOT NULL DEFAULT '', txn_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, completed_at TEXT
);
CREATE TRIGGER c_qbd_source_fixed BEFORE UPDATE OF source,kind ON c_qbd_requests WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'posting identity is permanent'); END;
CREATE TRIGGER c_qbd_success_fixed BEFORE UPDATE ON c_qbd_requests WHEN OLD.status='succeeded' AND NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'successful posting is permanent'); END;
CREATE TRIGGER c_qbd_success_kept BEFORE DELETE ON c_qbd_requests WHEN OLD.status='succeeded' AND NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'successful posting is permanent'); END;
