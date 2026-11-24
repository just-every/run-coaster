-- The hourly run and its polls read only what is open or recent: every statement they run finds its rows through one of
-- these indexes, so a run costs the same on the thirtieth day as on the thousandth. Claim status and age:
CREATE INDEX c_claims_status_updated ON c_claims(status, updated_at);
CREATE INDEX c_claims_batch ON c_claims(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX c_comments_open_questions ON c_comments(asks_email) WHERE asks_email IS NOT NULL;
CREATE INDEX c_workflow_tasks_waiting ON c_workflow_tasks(kind, record_id) WHERE status='waiting';
-- Card expenses still owing a receipt or a memo, receipts and their originals, expense dates and charge dates:
CREATE INDEX c_items_card_no_receipt ON c_items(card_charge_id) WHERE card_charge_id IS NOT NULL AND receipt_id IS NULL;
CREATE INDEX c_items_card_no_memo ON c_items(card_charge_id) WHERE card_charge_id IS NOT NULL AND trim(description)='';
CREATE INDEX c_items_receipt ON c_items(receipt_id) WHERE receipt_id IS NOT NULL;
CREATE INDEX c_items_spent_on ON c_items(spent_on, claim_id);
CREATE INDEX c_receipts_capture ON c_receipts(capture_receipt_id) WHERE capture_receipt_id IS NOT NULL;
CREATE INDEX c_card_charges_day ON c_card_charges(COALESCE(transaction_on, posted_on));
CREATE INDEX c_allocations_category ON c_allocations(category_id);
-- Webhook outbox: the events a subscription has already scanned, and the deliveries still waiting.
ALTER TABLE c_public_webhooks ADD COLUMN scanned_seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX c_public_webhook_deliveries_open ON c_public_webhook_deliveries(subscription_id, event_id) WHERE delivered_at IS NULL AND attempt<6;
