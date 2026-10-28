-- A bank statement's transaction identity can name an existing Plaid charge without creating another expense.
CREATE TABLE c_card_charge_aliases (
 transaction_key TEXT PRIMARY KEY, charge_id TEXT NOT NULL REFERENCES c_card_charges(id), file_id TEXT NOT NULL REFERENCES c_statement_files(id)
);
CREATE TRIGGER c_card_charge_aliases_immutable BEFORE UPDATE ON c_card_charge_aliases BEGIN SELECT RAISE(ABORT,'statement charge identity is permanent'); END;
CREATE TRIGGER c_card_charge_aliases_no_delete BEFORE DELETE ON c_card_charge_aliases BEGIN SELECT RAISE(ABORT,'statement charge identity is permanent'); END;
