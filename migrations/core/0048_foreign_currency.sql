ALTER TABLE c_business ADD COLUMN fx_enabled INTEGER NOT NULL DEFAULT 0 CHECK(fx_enabled IN (0,1));
ALTER TABLE c_items ADD COLUMN original_minor INTEGER;
ALTER TABLE c_items ADD COLUMN original_currency TEXT NOT NULL DEFAULT '';
ALTER TABLE c_items ADD COLUMN fx_rate TEXT NOT NULL DEFAULT '';
ALTER TABLE c_items ADD COLUMN fx_date TEXT NOT NULL DEFAULT '';
ALTER TABLE c_items ADD COLUMN fx_source TEXT NOT NULL DEFAULT '';
ALTER TABLE c_items ADD COLUMN original_sales_tax_minor INTEGER;
ALTER TABLE c_allocations ADD COLUMN original_minor INTEGER;
