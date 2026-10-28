-- Preserve provider decimal money separately from the native cent projection.
ALTER TABLE c_plaid_transactions ADD COLUMN provider_amount TEXT;
