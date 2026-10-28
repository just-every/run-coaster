-- Provider cursors and minimized financial facts are portable; execution custody remains installation-private.
CREATE TABLE c_plaid_sync_state (
 connection_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, cursor TEXT NOT NULL DEFAULT '', last_sync_at TEXT
);
CREATE TABLE c_plaid_assignments (
 connection_id TEXT NOT NULL, account_id TEXT NOT NULL, employee_email TEXT NOT NULL, category_id TEXT NOT NULL,
 card_id TEXT, assigned_by TEXT NOT NULL, assigned_at TEXT NOT NULL, PRIMARY KEY(connection_id,account_id)
);
CREATE TABLE c_plaid_transactions (
 connection_id TEXT NOT NULL, transaction_id TEXT NOT NULL, account_id TEXT NOT NULL,
 pending_transaction_id TEXT, status TEXT NOT NULL CHECK(status IN ('pending','posted','removed','review','credit','overlap')),
 spent_on TEXT NOT NULL, posted_on TEXT NOT NULL, merchant TEXT NOT NULL, amount_minor INTEGER NOT NULL,
 currency TEXT NOT NULL, employee_email TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('company','personal')),
 item_id TEXT, charge_id TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(connection_id,transaction_id)
);
CREATE INDEX c_plaid_transactions_item ON c_plaid_transactions(item_id);
CREATE TABLE c_plaid_changes (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT NOT NULL, transaction_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('added','modified','removed')), facts TEXT NOT NULL CHECK(json_valid(facts)), at TEXT NOT NULL
);
CREATE TRIGGER c_plaid_changes_immutable BEFORE UPDATE ON c_plaid_changes WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'Plaid source history is permanent'); END;
CREATE TRIGGER c_plaid_changes_no_delete BEFORE DELETE ON c_plaid_changes BEGIN SELECT RAISE(ABORT,'Plaid source history is permanent'); END;
CREATE TABLE c_plaid_sources (
 id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, transaction_id TEXT NOT NULL, bytes BLOB NOT NULL,
 sha256 TEXT NOT NULL, size INTEGER NOT NULL, mapping TEXT NOT NULL CHECK(json_valid(mapping)), created_at TEXT NOT NULL
);
CREATE TRIGGER c_plaid_sources_immutable BEFORE UPDATE ON c_plaid_sources BEGIN SELECT RAISE(ABORT,'Plaid source evidence is permanent'); END;
CREATE TRIGGER c_plaid_sources_no_delete BEFORE DELETE ON c_plaid_sources BEGIN SELECT RAISE(ABORT,'Plaid source evidence is permanent'); END;
CREATE VIEW c_card_sources AS SELECT id,mapping,undone_at FROM c_statement_files UNION ALL SELECT id,mapping,NULL AS undone_at FROM c_plaid_sources;
