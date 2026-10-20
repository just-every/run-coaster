-- CLAIM-002: the exact daily rates and meal deductions are evidence, copied with the expense and revision.
ALTER TABLE c_items ADD COLUMN per_diem TEXT NOT NULL DEFAULT '' CHECK(per_diem='' OR json_valid(per_diem));
