-- PAY-004: who may release payments, dual release above an amount, the release record and the reimbursement day.
ALTER TABLE c_members ADD COLUMN may_release INTEGER NOT NULL DEFAULT 0 CHECK (may_release IN (0, 1));
ALTER TABLE c_business ADD COLUMN dual_release_over_minor INTEGER CHECK (dual_release_over_minor IS NULL OR dual_release_over_minor >= 0);
ALTER TABLE c_business ADD COLUMN pay_weekday INTEGER CHECK (pay_weekday IS NULL OR pay_weekday BETWEEN 0 AND 6);
ALTER TABLE c_batches ADD COLUMN first_released_by TEXT;
ALTER TABLE c_batches ADD COLUMN first_released_at TEXT;
ALTER TABLE c_batches ADD COLUMN released_by TEXT;
ALTER TABLE c_batches ADD COLUMN released_at TEXT;
-- One row per business-time-zone day the reimbursement schedule ran, so the hourly run opens at most one batch a day.
CREATE TABLE c_pay_runs (
  day TEXT PRIMARY KEY,
  ran_at TEXT NOT NULL,
  batch_id TEXT
);
