CREATE TABLE c_gusto_connection (
  id INTEGER PRIMARY KEY CHECK(id=1),
  company_uuid TEXT NOT NULL,
  company_name TEXT NOT NULL,
  token_sealed TEXT NOT NULL,
  connected_by TEXT NOT NULL,
  connected_at TEXT NOT NULL
);
CREATE TABLE c_gusto_employees (
  email TEXT PRIMARY KEY REFERENCES c_members(email),
  company_uuid TEXT NOT NULL,
  employee_uuid TEXT NOT NULL,
  UNIQUE(company_uuid,employee_uuid)
);
CREATE TABLE c_payroll_handoffs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL UNIQUE REFERENCES c_batches(id),
  company_uuid TEXT NOT NULL,
  payroll_uuid TEXT NOT NULL UNIQUE,
  check_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','sent','confirmed')),
  lines TEXT NOT NULL CHECK(json_valid(lines)),
  expected TEXT NOT NULL CHECK(json_valid(expected)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE TRIGGER c_payroll_identity BEFORE UPDATE ON c_payroll_handoffs
WHEN NOT EXISTS(SELECT 1 FROM c_erasing) AND (NEW.id<>OLD.id OR NEW.batch_id<>OLD.batch_id OR NEW.company_uuid<>OLD.company_uuid
  OR NEW.payroll_uuid<>OLD.payroll_uuid OR NEW.check_date<>OLD.check_date OR NEW.lines<>OLD.lines
  OR NEW.expected<>OLD.expected OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at
  OR NOT ((OLD.status='reserved' AND NEW.status='sent') OR (OLD.status='sent' AND NEW.status='confirmed') OR (OLD.status='reserved' AND NEW.status='confirmed')))
BEGIN SELECT RAISE(ABORT,'Payroll handoff evidence is immutable'); END;
CREATE TRIGGER c_payroll_no_delete BEFORE DELETE ON c_payroll_handoffs WHEN NOT EXISTS(SELECT 1 FROM c_expiring WHERE target=OLD.batch_id)
BEGIN SELECT RAISE(ABORT,'Payroll handoff evidence is immutable'); END;
