CREATE TABLE c_hris_connection (
 id INTEGER PRIMARY KEY CHECK(id=1), company_uuid TEXT NOT NULL, company_name TEXT NOT NULL,
 token_sealed TEXT NOT NULL, connected_by TEXT NOT NULL, connected_at TEXT NOT NULL
);
CREATE TABLE c_hris_mappings (
 employee_uuid TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, company_uuid TEXT NOT NULL
);
