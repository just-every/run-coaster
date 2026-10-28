-- Personal purchases retain private card provenance while remaining ordinary reimbursable expenses.
CREATE TABLE c_plaid_personal_charges (
 id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES c_plaid_sources(id),
 connection_id TEXT NOT NULL, transaction_id TEXT NOT NULL, employee_email TEXT NOT NULL,
 transaction_key TEXT NOT NULL UNIQUE, posted_on TEXT NOT NULL, transaction_on TEXT NOT NULL,
 descriptor TEXT NOT NULL, memo TEXT NOT NULL DEFAULT '', amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
 currency TEXT NOT NULL, item_id TEXT NOT NULL UNIQUE, category_id TEXT NOT NULL, claim_id TEXT NOT NULL,
 last4 TEXT NOT NULL CHECK(length(last4)=4 AND last4 NOT GLOB '*[^0-9]*'), created_at TEXT NOT NULL
);
CREATE TRIGGER c_plaid_personal_charges_immutable BEFORE UPDATE ON c_plaid_personal_charges WHEN NOT EXISTS(SELECT 1 FROM c_erasing)
 BEGIN SELECT RAISE(ABORT,'personal card source facts are permanent'); END;
CREATE TRIGGER c_plaid_personal_charges_no_delete BEFORE DELETE ON c_plaid_personal_charges
 BEGIN SELECT RAISE(ABORT,'personal card source facts are permanent'); END;
ALTER TABLE c_items ADD COLUMN personal_card_charge_id TEXT;
CREATE INDEX c_items_personal_card_charge ON c_items(personal_card_charge_id) WHERE personal_card_charge_id IS NOT NULL;
-- Only the receipt service consumes this view; company spend readers continue using company charges alone.
CREATE VIEW c_receipt_card_charges AS
 SELECT ch.*,card.last4,'company' AS liability FROM c_card_charges ch JOIN c_cards card ON card.id=ch.card_id
 UNION ALL
 SELECT id,file_id,NULL AS card_id,employee_email,transaction_key,posted_on,transaction_on,descriptor,memo,amount_minor,
 currency,NULL AS original_minor,'' AS original_currency,item_id,category_id,created_at,claim_id,last4,'personal' AS liability
 FROM c_plaid_personal_charges;
CREATE TRIGGER c_match_dirty_personal_charge AFTER INSERT ON c_plaid_personal_charges
 BEGIN UPDATE c_card_match_epoch SET version=version+1 WHERE id=1;
 INSERT INTO c_card_match_generations(employee_email,version) VALUES(NEW.employee_email,1)
 ON CONFLICT(employee_email) DO UPDATE SET version=version+1; END;
