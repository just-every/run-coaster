-- Financial safety state is portable, unlike installation-private connection credentials.
-- The starting cursor stays unchanged until every financial batch has committed.
ALTER TABLE c_plaid_sync_state ADD COLUMN in_progress INTEGER NOT NULL DEFAULT 0 CHECK(in_progress IN (0,1));
ALTER TABLE c_plaid_sync_state ADD COLUMN attempt_id TEXT;
ALTER TABLE c_plaid_sync_state ADD COLUMN lease_until INTEGER;
