-- AGENT-002: only the person's confirmed comparison is shared with the expense.
ALTER TABLE c_items ADD COLUMN receipt_resolution TEXT CHECK(receipt_resolution IS NULL OR json_valid(receipt_resolution));
