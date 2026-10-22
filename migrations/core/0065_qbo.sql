-- QuickBooks metadata connection; credentials are encrypted, never copied into domain archives.
CREATE TABLE c_qbo_connections (
  id INTEGER PRIMARY KEY CHECK(id=1),
  realm_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  tokens_sealed TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  refresh_hour INTEGER NOT NULL DEFAULT 3 CHECK(refresh_hour BETWEEN 0 AND 23),
  last_refresh_day TEXT,
  last_refresh_at TEXT,
  last_error TEXT,
  connected_by TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE c_qbo_oauth_states (
  state_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  origin TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  connection_version INTEGER NOT NULL
);
