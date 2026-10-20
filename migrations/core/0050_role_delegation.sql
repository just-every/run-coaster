-- APPROVE-001 / APPROVE-002: manager and finance authority never substitute for one another.
ALTER TABLE c_delegations ADD COLUMN review_role TEXT NOT NULL DEFAULT 'manager' CHECK(review_role IN ('manager','finance'));
