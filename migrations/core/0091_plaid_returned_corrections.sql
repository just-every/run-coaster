-- Returned claims can take an explicitly consented correction while keeping every submitted revision.
ALTER TABLE c_plaid_corrections ADD COLUMN claim_state TEXT NOT NULL DEFAULT 'draft' CHECK(claim_state IN ('draft','returned'));
