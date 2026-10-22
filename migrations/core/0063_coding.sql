-- CODE-001: native catalogs and ledger catalog provenance are separate. No ledger connection is implied by native entry.
CREATE TABLE c_coding_version (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
INSERT INTO c_coding_version VALUES(1,0);
CREATE TABLE c_coding_dimensions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('account','class','location','department','project','customer','vendor','tag','cost-centre')),
  parent_id TEXT REFERENCES c_coding_dimensions(id),
  required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  source TEXT NOT NULL CHECK(source IN ('native','quickbooks')),
  source_company TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  CHECK(parent_id IS NULL OR parent_id<>id)
);
CREATE TABLE c_coding_values (
  id TEXT PRIMARY KEY,
  dimension_id TEXT NOT NULL REFERENCES c_coding_dimensions(id),
  name TEXT NOT NULL,
  parent_value_id TEXT REFERENCES c_coding_values(id),
  owner_email TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  source_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX c_coding_value_name ON c_coding_values(dimension_id,COALESCE(parent_value_id,''),name);
CREATE UNIQUE INDEX c_coding_source_value ON c_coding_values(dimension_id,source_id) WHERE source_id<>'';
CREATE TABLE c_category_dimensions (
  category_id TEXT NOT NULL REFERENCES c_categories(id),
  dimension_id TEXT NOT NULL REFERENCES c_coding_dimensions(id),
  required INTEGER NOT NULL DEFAULT 1 CHECK(required IN (0,1)),
  PRIMARY KEY(category_id,dimension_id)
);
CREATE TABLE c_coding_refreshes (
  company TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  counts TEXT NOT NULL CHECK(json_valid(counts)),
  PRIMARY KEY(company,refreshed_at)
);
CREATE TRIGGER c_coding_refreshes_immutable BEFORE UPDATE ON c_coding_refreshes BEGIN SELECT RAISE(ABORT,'catalog refresh history is permanent'); END;
CREATE TRIGGER c_coding_refreshes_no_delete BEFORE DELETE ON c_coding_refreshes BEGIN SELECT RAISE(ABORT,'catalog refresh history is permanent'); END;
ALTER TABLE c_items ADD COLUMN coding TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(coding));

-- Preserve every earlier budget version while admitting project and tag scopes.
CREATE TABLE c_budgets_coding (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>=1),
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('entity','category','cost-centre','department','project','tag')),
  scope_key TEXT NOT NULL DEFAULT '',
  per_member INTEGER NOT NULL CHECK(per_member IN (0,1)),
  period TEXT NOT NULL CHECK(period IN ('monthly','quarterly','yearly')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
  owner_email TEXT NOT NULL,
  thresholds TEXT NOT NULL CHECK(json_valid(thresholds)),
  policy_rule INTEGER NOT NULL CHECK(policy_rule IN (0,1)),
  retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  alert_amounts INTEGER NOT NULL DEFAULT 0 CHECK(alert_amounts IN (0,1)),
  scope_category TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(id,version)
);
INSERT INTO c_budgets_coding SELECT * FROM c_budgets;
DROP TABLE c_budgets;
ALTER TABLE c_budgets_coding RENAME TO c_budgets;
CREATE TRIGGER c_budgets_append_only BEFORE UPDATE ON c_budgets WHEN NOT EXISTS(SELECT 1 FROM c_erasing) BEGIN SELECT RAISE(ABORT,'claim history is permanent'); END;
CREATE TRIGGER c_budgets_no_delete BEFORE DELETE ON c_budgets BEGIN SELECT RAISE(ABORT,'claim history is permanent'); END;
