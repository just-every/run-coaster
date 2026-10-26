-- Private reply credentials travel with installation archives, never claim history.
CREATE TABLE c_comment_email_tokens (
 question_id TEXT PRIMARY KEY REFERENCES c_comments(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 member_id TEXT NOT NULL,
 destination TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE c_comment_email_answers (
 message_sha256 TEXT PRIMARY KEY CHECK(length(message_sha256)=64),
 comment_id TEXT NOT NULL UNIQUE REFERENCES c_comments(id) ON DELETE CASCADE
);
CREATE TRIGGER c_comment_email_tokens_permanent BEFORE UPDATE ON c_comment_email_tokens
BEGIN SELECT RAISE(ABORT,'question reply credential is permanent'); END;
CREATE TRIGGER c_comment_email_answers_permanent BEFORE UPDATE ON c_comment_email_answers
BEGIN SELECT RAISE(ABORT,'email answer provenance is permanent'); END;
-- Erasure invalidates outstanding credentials in the same transaction, including
-- questions authored by someone else and addressed to the erased member.
CREATE TRIGGER c_comment_email_erasure AFTER INSERT ON c_erasing
BEGIN
 DELETE FROM c_comment_email_tokens WHERE member_id IN (SELECT member_id FROM c_members WHERE email=NEW.email)
  OR question_id IN (SELECT id FROM c_comments WHERE author_email=NEW.email OR asks_email=NEW.email);
END;
