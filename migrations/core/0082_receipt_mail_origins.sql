-- Historical sources retain unknown origin; only newly parsed messages identify their parts.
ALTER TABLE c_receipt_mail_sources ADD COLUMN origin TEXT CHECK(origin IN ('body','attachment'));
CREATE INDEX c_receipt_mail_sources_message ON c_receipt_mail_sources(message_id);
