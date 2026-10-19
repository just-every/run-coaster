-- Exports alongside live sync (ACCT-005). Finance saves column templates for the
-- accounting and reimbursement files: which fields, in what order, under what
-- headers. The built-in default keeps every field.
CREATE TABLE c_export_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('accounting', 'reimbursements')),
  columns TEXT NOT NULL CHECK (json_valid(columns)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
