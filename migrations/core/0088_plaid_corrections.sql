-- Explicit native consent resolves one exact provider change for a pristine, never-submitted projection only.
-- Old source bytes and company charges remain permanent. Erasure may redact retained identities and JSON snapshots.
CREATE TABLE c_plaid_corrections (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 connection_id TEXT NOT NULL,
 transaction_id TEXT NOT NULL,
 change_seq INTEGER NOT NULL REFERENCES c_plaid_changes(seq),
 scope TEXT NOT NULL CHECK(scope IN ('company','personal')),
 employee_email TEXT NOT NULL,
 claim_id TEXT NOT NULL,
 claim_version INTEGER NOT NULL CHECK(claim_version > 0),
 old_source_id TEXT NOT NULL REFERENCES c_plaid_sources(id),
 old_item_id TEXT NOT NULL,
 old_charge_id TEXT,
 new_source_id TEXT REFERENCES c_plaid_sources(id),
 new_item_id TEXT,
 new_charge_id TEXT,
 reason TEXT NOT NULL CHECK(reason IN ('provider-replacement','provider-removal')),
 consent INTEGER NOT NULL CHECK(consent=1),
 prior_snapshot TEXT NOT NULL CHECK(json_valid(prior_snapshot)),
 actor_email TEXT NOT NULL,
 at TEXT NOT NULL,
 UNIQUE(connection_id,transaction_id,change_seq),
 UNIQUE(old_item_id),
 UNIQUE(new_item_id),
 CHECK((scope='company')=(old_charge_id IS NOT NULL)),
 CHECK((reason='provider-removal' AND new_source_id IS NULL AND new_item_id IS NULL AND new_charge_id IS NULL)
    OR (reason='provider-replacement' AND new_source_id IS NOT NULL AND new_item_id IS NOT NULL
        AND (scope='company')=(new_charge_id IS NOT NULL))),
 CHECK(new_source_id IS NULL OR new_source_id<>old_source_id),
 CHECK(new_item_id IS NULL OR new_item_id<>old_item_id),
 CHECK(new_charge_id IS NULL OR new_charge_id<>old_charge_id)
);
CREATE INDEX c_plaid_corrections_source ON c_plaid_corrections(old_source_id,new_source_id);
CREATE TRIGGER c_plaid_corrections_immutable BEFORE UPDATE ON c_plaid_corrections
 WHEN NOT EXISTS(SELECT 1 FROM c_erasing)
 BEGIN SELECT RAISE(ABORT,'Plaid corrections are permanent'); END;
CREATE TRIGGER c_plaid_corrections_no_delete BEFORE DELETE ON c_plaid_corrections
 BEGIN SELECT RAISE(ABORT,'Plaid corrections are permanent'); END;
