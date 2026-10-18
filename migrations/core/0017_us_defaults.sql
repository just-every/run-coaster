-- US-first defaults (LOCALE-001). The mileage rate becomes an effective-dated
-- table (seeded with the IRS standard business rates when a USD business is
-- set up) and each mileage expense takes the rate in force on its trip date; an
-- existing single rate carries over as the rate for every date. Receipts carry
-- sales tax as their own amount, copied with the business's sales tax account
-- and tax code onto the expense; a category can always need a receipt (lodging).
CREATE TABLE c_mileage_rates (
  effective_from TEXT PRIMARY KEY CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  rate_thousandths INTEGER NOT NULL CHECK (rate_thousandths > 0)
);
INSERT INTO c_mileage_rates(effective_from, rate_thousandths) SELECT '2000-01-01', mileage_rate_thousandths FROM c_business WHERE mileage_rate_thousandths > 0;
ALTER TABLE c_business DROP COLUMN mileage_rate_thousandths;
ALTER TABLE c_business ADD COLUMN sales_tax_account TEXT NOT NULL DEFAULT '';
ALTER TABLE c_business ADD COLUMN sales_tax_code TEXT NOT NULL DEFAULT '';
ALTER TABLE c_categories ADD COLUMN receipt_always INTEGER NOT NULL DEFAULT 0 CHECK (receipt_always IN (0, 1));
ALTER TABLE c_items ADD COLUMN sales_tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (sales_tax_minor >= 0);
ALTER TABLE c_items ADD COLUMN sales_tax_account TEXT NOT NULL DEFAULT '';
ALTER TABLE c_items ADD COLUMN sales_tax_code TEXT NOT NULL DEFAULT '';
