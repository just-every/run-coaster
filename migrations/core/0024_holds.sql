-- Hold one expense, approve the rest (APPROVE-005). The held expenses move to a
-- new claim that stays with the employee and names the claim it came from, the
-- approver who held it, when, and why.
ALTER TABLE c_claims ADD COLUMN held_from TEXT;
ALTER TABLE c_claims ADD COLUMN held_by TEXT;
ALTER TABLE c_claims ADD COLUMN held_at TEXT;
ALTER TABLE c_claims ADD COLUMN hold_reason TEXT;
