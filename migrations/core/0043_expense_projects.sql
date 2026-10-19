-- CLAIM-006: native project coding, retained in submitted revision snapshots.
ALTER TABLE c_items ADD COLUMN project TEXT NOT NULL DEFAULT '';
