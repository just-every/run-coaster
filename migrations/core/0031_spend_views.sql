-- Spend analytics saved views (REPORT-001): a person's own named grouping and period.
CREATE TABLE c_spend_views (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  query TEXT NOT NULL CHECK (json_valid(query)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (owner_email, name)
);
