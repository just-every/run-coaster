-- Recurring expenses and stipends (CLAIM-009). Finance sets allowances: a fixed
-- stipend paid each period without a receipt, or a cap expenses are claimed
-- against; employees set their own recurring expenses. Each period's stipend or
-- recurring draft is created once by the hourly run.
--
-- A stipend is its own expense kind, so c_items is rebuilt to widen its kind
-- check. Dropping c_items cascades to c_allocations (ON DELETE CASCADE), so the
-- allocations are kept aside first and put back once the new table is in place.
CREATE TABLE c_items_new (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES c_claims(id),
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('receipt', 'mileage', 'per_diem', 'stipend')),
  spent_on TEXT NOT NULL,
  merchant TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  distance_hundredths INTEGER CHECK (distance_hundredths IS NULL OR distance_hundredths > 0),
  days INTEGER CHECK (days IS NULL OR days > 0),
  rate_thousandths INTEGER CHECK (rate_thousandths IS NULL OR rate_thousandths > 0),
  receipt_id TEXT REFERENCES c_receipts(id),
  explanation TEXT NOT NULL DEFAULT '',
  sales_tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (sales_tax_minor >= 0),
  sales_tax_account TEXT NOT NULL DEFAULT '',
  sales_tax_code TEXT NOT NULL DEFAULT '',
  attendees TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attendees)),
  fields TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields)),
  request_id TEXT REFERENCES c_requests(id),
  allowance_id TEXT,
  claimed_minor INTEGER CHECK (claimed_minor IS NULL OR claimed_minor > amount_minor)
);
INSERT INTO c_items_new(id,claim_id,position,kind,spent_on,merchant,description,amount_minor,distance_hundredths,days,rate_thousandths,receipt_id,explanation,sales_tax_minor,sales_tax_account,sales_tax_code,attendees,fields,request_id)
  SELECT id,claim_id,position,kind,spent_on,merchant,description,amount_minor,distance_hundredths,days,rate_thousandths,receipt_id,explanation,sales_tax_minor,sales_tax_account,sales_tax_code,attendees,fields,request_id FROM c_items;
CREATE TABLE c_allocations_keep AS SELECT item_id,position,category_id,cost_centre,amount_minor,description FROM c_allocations;
DROP TABLE c_items;
ALTER TABLE c_items_new RENAME TO c_items;
CREATE INDEX c_items_claim ON c_items(claim_id, position);
CREATE INDEX c_items_request ON c_items(request_id);
CREATE INDEX c_items_allowance ON c_items(allowance_id);
INSERT INTO c_allocations(item_id,position,category_id,cost_centre,amount_minor,description)
  SELECT item_id,position,category_id,cost_centre,amount_minor,description FROM c_allocations_keep;
DROP TABLE c_allocations_keep;

CREATE TABLE c_allowances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('stipend', 'cap')),
  member_email TEXT,
  category_id TEXT REFERENCES c_categories(id),
  period TEXT NOT NULL CHECK (period IN ('monthly', 'quarterly', 'yearly')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  tax TEXT CHECK (tax IS NULL OR tax IN ('accountable', 'taxable')),
  starts_on TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  stopped_by TEXT,
  stopped_at TEXT,
  -- A stipend is coded to a category and taxed one way; a cap only limits what is reimbursed.
  CHECK ((type = 'stipend') = (tax IS NOT NULL AND category_id IS NOT NULL))
);
CREATE TABLE c_recurring (
  id TEXT PRIMARY KEY,
  member_email TEXT NOT NULL,
  merchant TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_id TEXT NOT NULL REFERENCES c_categories(id),
  period TEXT NOT NULL CHECK (period IN ('monthly', 'quarterly', 'yearly')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  starts_on TEXT NOT NULL,
  set_at TEXT NOT NULL,
  stopped_at TEXT
);
-- One stipend claim per allowance, person and period; one draft per recurring expense and period.
CREATE TABLE c_allowance_runs (
  source_id TEXT NOT NULL,
  member_email TEXT NOT NULL,
  period TEXT NOT NULL,
  claim_id TEXT NOT NULL REFERENCES c_claims(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, member_email, period)
);
