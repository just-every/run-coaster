-- CODE-001: an explicit chart-account mapping is separate from the existing manual export code.
-- Its selected provider identity and label are retained even when the live account is renamed or archived.
ALTER TABLE c_categories ADD COLUMN ledger_account_id TEXT REFERENCES c_coding_values(id);
ALTER TABLE c_categories ADD COLUMN ledger_account_snapshot TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(ledger_account_snapshot));
