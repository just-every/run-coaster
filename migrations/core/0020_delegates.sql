-- Delegates who prepare and submit for someone else (ADMIN-005). A member
-- grants another member Submit only or Full access to act in their name; every
-- action the delegate takes records both people. One live grant per pair.
CREATE TABLE c_delegates (
  id TEXT PRIMARY KEY,
  grantor_email TEXT NOT NULL,
  delegate_email TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('submit', 'full')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_by TEXT,
  revoked_at TEXT,
  CHECK (delegate_email <> grantor_email)
);
CREATE UNIQUE INDEX c_delegates_live ON c_delegates(grantor_email, delegate_email) WHERE revoked_at IS NULL;
