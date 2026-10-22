-- Public API authority is separate from native sessions and proposal-only agent keys.
CREATE TABLE c_public_keys (
 id TEXT PRIMARY KEY, member_email TEXT NOT NULL REFERENCES c_members(email), label TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL CHECK(json_valid(scopes)),
 access_snapshot TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL,
 revoked_at TEXT, oauth_client TEXT
);
CREATE TABLE c_public_oauth_clients (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, redirect_uri TEXT NOT NULL,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE c_public_oauth_codes (
 code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES c_public_oauth_clients(id),
 member_email TEXT NOT NULL REFERENCES c_members(email), scopes TEXT NOT NULL,
 access_snapshot TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL,
 consumed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE c_public_webhooks (
 id TEXT PRIMARY KEY, destination TEXT NOT NULL, secret_sealed TEXT NOT NULL,
 events TEXT NOT NULL CHECK(json_valid(events)), created_by TEXT NOT NULL,
 access_snapshot TEXT NOT NULL, start_seq INTEGER NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE c_public_webhook_deliveries (
 subscription_id TEXT NOT NULL REFERENCES c_public_webhooks(id), event_id TEXT NOT NULL REFERENCES c_events(id),
 attempt INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0, delivered_at TEXT, last_status INTEGER,
 PRIMARY KEY(subscription_id,event_id)
);
-- Access edits permanently invalidate grants, even if the same role set is later restored.
CREATE TRIGGER c_public_member_access_changed AFTER UPDATE ON c_members BEGIN
 UPDATE c_public_keys SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE member_email=OLD.email;
 UPDATE c_public_oauth_codes SET consumed_at=COALESCE(consumed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE member_email=OLD.email;
 UPDATE c_public_webhooks SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE created_by=OLD.email;
END;
CREATE TRIGGER c_public_operator_access_changed AFTER UPDATE OF email,version,role,status ON oa_operators BEGIN
 UPDATE c_public_keys SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE member_email=lower(OLD.email);
 UPDATE c_public_oauth_codes SET consumed_at=COALESCE(consumed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE member_email=lower(OLD.email);
 UPDATE c_public_webhooks SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE created_by=lower(OLD.email);
END;
