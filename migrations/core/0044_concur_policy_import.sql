-- A policy move-in owns its adoption marker. Undo appends a compensating
-- version; the imported version and every revision that used it stay permanent.
CREATE TABLE c_concur_policy_imports (
 id TEXT PRIMARY KEY,
 revision TEXT NOT NULL,
 value TEXT NOT NULL CHECK(json_valid(value)),
 policy_version INTEGER NOT NULL REFERENCES c_policies(version)
);
