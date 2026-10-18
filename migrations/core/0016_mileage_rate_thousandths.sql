-- Mileage rates are set in tenths of a cent, as the IRS sets them (72.5 cents a
-- mile for 2026), so business and expense rates are kept in thousandths of the
-- currency unit. Per diem rates copied onto expenses move to the same unit.
ALTER TABLE c_business RENAME COLUMN mileage_rate_minor TO mileage_rate_thousandths;
UPDATE c_business SET mileage_rate_thousandths = mileage_rate_thousandths * 10;
ALTER TABLE c_items RENAME COLUMN rate_minor TO rate_thousandths;
UPDATE c_items SET rate_thousandths = rate_thousandths * 10;
