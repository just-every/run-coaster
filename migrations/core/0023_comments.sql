-- Comments and questions without a decision (APPROVE-006). Anyone who can see a
-- claim comments on it or on one expense, or asks a named person a question;
-- the named person's reply answers it. Comments never touch the claim's state.
-- They are history: never deleted, and frozen once anyone has replied.
CREATE TABLE c_comments (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES c_claims(id),
  item_id TEXT,
  parent_id TEXT,
  author_email TEXT NOT NULL,
  on_behalf_of TEXT,
  asks_email TEXT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL,
  edited_at TEXT,
  CHECK (parent_id IS NULL OR asks_email IS NULL)
);
CREATE INDEX c_comments_claim ON c_comments(claim_id, created_at);
CREATE INDEX c_comments_parent ON c_comments(parent_id);
CREATE TRIGGER c_comments_no_delete BEFORE DELETE ON c_comments BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
CREATE TRIGGER c_comments_frozen BEFORE UPDATE ON c_comments
  WHEN EXISTS(SELECT 1 FROM c_comments r WHERE r.parent_id=OLD.id) OR NEW.id IS NOT OLD.id OR NEW.claim_id IS NOT OLD.claim_id OR NEW.item_id IS NOT OLD.item_id
    OR NEW.parent_id IS NOT OLD.parent_id OR NEW.author_email IS NOT OLD.author_email OR NEW.on_behalf_of IS NOT OLD.on_behalf_of OR NEW.asks_email IS NOT OLD.asks_email OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
