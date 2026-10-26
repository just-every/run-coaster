-- Installation mail intake and private original-message custody.
CREATE TABLE c_receipt_mail_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), address TEXT NOT NULL, version INTEGER NOT NULL,
 consent_at TEXT NOT NULL, set_by TEXT NOT NULL
);
CREATE TABLE c_receipt_mail_aliases (
 email TEXT PRIMARY KEY, owner_email TEXT NOT NULL, proof_hash TEXT NOT NULL,
 expires_at TEXT NOT NULL, confirmed_at TEXT, requested_at TEXT NOT NULL
);
CREATE TABLE c_receipt_mail_messages (
 id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, object_key TEXT NOT NULL UNIQUE,
 size INTEGER NOT NULL CHECK(size>0 AND size<=25000000), sender TEXT NOT NULL,
 recipient TEXT NOT NULL, subject TEXT NOT NULL, owner_email TEXT,
 received_at TEXT NOT NULL, held_reason TEXT NOT NULL,
 CHECK ((owner_email IS NULL AND held_reason<>'') OR (owner_email IS NOT NULL AND held_reason=''))
);
CREATE TABLE c_receipt_mail_sources (
 receipt_id TEXT PRIMARY KEY REFERENCES c_capture_receipts(id),
 message_id TEXT NOT NULL REFERENCES c_receipt_mail_messages(id)
);
CREATE TRIGGER c_receipt_mail_messages_permanent BEFORE UPDATE OF id,sha256,object_key,size,recipient,subject,received_at,held_reason ON c_receipt_mail_messages
BEGIN SELECT RAISE(ABORT,'source mail is permanent'); END;
CREATE TRIGGER c_receipt_mail_messages_no_delete BEFORE DELETE ON c_receipt_mail_messages
BEGIN SELECT RAISE(ABORT,'source mail is permanent'); END;
CREATE TRIGGER c_receipt_mail_sources_permanent BEFORE UPDATE ON c_receipt_mail_sources
BEGIN SELECT RAISE(ABORT,'source mail is permanent'); END;
CREATE TRIGGER c_receipt_mail_sources_no_delete BEFORE DELETE ON c_receipt_mail_sources
BEGIN SELECT RAISE(ABORT,'source mail is permanent'); END;
CREATE TRIGGER c_receipt_mail_messages_identity BEFORE UPDATE OF sender,owner_email ON c_receipt_mail_messages WHEN NOT EXISTS(SELECT 1 FROM c_capture_erasing)
BEGIN SELECT RAISE(ABORT,'source mail identity is permanent'); END;
