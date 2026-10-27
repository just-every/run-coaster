CREATE TABLE c_plaid_settings (
  id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL,
  credentials_sealed TEXT NOT NULL, account_monthly_minor INTEGER NOT NULL CHECK(account_monthly_minor>=0),
  monthly_cap_minor INTEGER CHECK(monthly_cap_minor>=0), set_by TEXT NOT NULL, set_at TEXT NOT NULL
);
CREATE TABLE c_plaid_links (
  id TEXT PRIMARY KEY, member_email TEXT NOT NULL, session_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('company','personal')), settings_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, delegate_grant TEXT, public_token_hash TEXT UNIQUE, reserved_at TEXT
);
CREATE TABLE c_plaid_connections (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('company','personal')),
  personal_email TEXT, item_id TEXT NOT NULL UNIQUE, credentials_sealed TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','connected')),
  accounts TEXT NOT NULL CHECK(json_valid(accounts)), connected_by TEXT NOT NULL, connected_at TEXT NOT NULL,
  CHECK((scope='company' AND personal_email IS NULL) OR (scope='personal' AND personal_email IS NOT NULL))
);
CREATE TABLE c_plaid_costs (
  month TEXT NOT NULL, connection_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('reserved','settled')), accounts INTEGER NOT NULL CHECK(accounts>0),
  account_monthly_minor INTEGER NOT NULL CHECK(account_monthly_minor>=0), usd_minor INTEGER NOT NULL CHECK(usd_minor>=0),
  recorded_at TEXT NOT NULL, PRIMARY KEY(month,connection_id,kind)
);
