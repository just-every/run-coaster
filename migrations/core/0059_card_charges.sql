-- Company-card charges from statement files (FEED-002 statement import, FEED-004 card expenses). Only the last four
-- digits of a card are ever stored (SEC-001); statement facts are immutable once imported.
CREATE TABLE c_cards (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 60),
  last4 TEXT NOT NULL CHECK (length(last4) = 4 AND last4 NOT GLOB '*[^0-9]*'),
  employee_email TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  UNIQUE (issuer, last4)
);

-- The retained original is the masked file: the bytes below never hold a full card number.
CREATE TABLE c_statement_files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('ofx', 'qfx', 'csv')),
  issuer TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  period_start TEXT,
  period_end TEXT,
  mapping TEXT NOT NULL CHECK (json_valid(mapping)),
  excluded_cards TEXT NOT NULL CHECK (json_valid(excluded_cards)),
  included_rows TEXT NOT NULL CHECK (json_valid(included_rows)),
  charges INTEGER NOT NULL,
  total_minor INTEGER NOT NULL,
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  undone_at TEXT,
  undone_by TEXT
);
CREATE INDEX c_statement_files_fingerprint ON c_statement_files(fingerprint);
CREATE TRIGGER c_statement_files_immutable BEFORE UPDATE ON c_statement_files
  WHEN NOT EXISTS(SELECT 1 FROM c_erasing) AND (OLD.undone_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.bytes IS NOT OLD.bytes OR NEW.sha256 IS NOT OLD.sha256 OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.imported_by IS NOT OLD.imported_by OR NEW.charges IS NOT OLD.charges OR NEW.total_minor IS NOT OLD.total_minor)
  BEGIN SELECT RAISE(ABORT, 'a statement file is permanent; only its undo is recorded'); END;
CREATE TRIGGER c_statement_files_no_delete BEFORE DELETE ON c_statement_files BEGIN SELECT RAISE(ABORT, 'a statement file is permanent'); END;

-- One charge per statement transaction. transaction_key is the COA-005 exact key for card spend.
CREATE TABLE c_card_charges (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  employee_email TEXT NOT NULL,
  transaction_key TEXT NOT NULL UNIQUE,
  posted_on TEXT NOT NULL,
  transaction_on TEXT,
  descriptor TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  original_minor INTEGER,
  original_currency TEXT NOT NULL DEFAULT '',
  item_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX c_card_charges_file ON c_card_charges(file_id);
CREATE INDEX c_card_charges_employee ON c_card_charges(employee_email, posted_on);
CREATE TRIGGER c_card_charges_immutable BEFORE UPDATE ON c_card_charges WHEN NOT EXISTS(SELECT 1 FROM c_erasing)
  BEGIN SELECT RAISE(ABORT, 'statement facts are immutable'); END;
CREATE TRIGGER c_card_charges_undo_only BEFORE DELETE ON c_card_charges
  WHEN NOT EXISTS(SELECT 1 FROM c_statement_files f WHERE f.id=OLD.file_id AND f.undone_at IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'a card charge is removed only by undoing its statement import'); END;
CREATE TRIGGER c_cards_no_delete BEFORE DELETE ON c_cards BEGIN SELECT RAISE(ABORT, 'a card record is permanent'); END;

-- A card expense is an ordinary expense row carrying its charge: it never adds to a reimbursable total (FEED-004).
ALTER TABLE c_items ADD COLUMN card_charge_id TEXT;
CREATE INDEX c_items_card_charge ON c_items(card_charge_id) WHERE card_charge_id IS NOT NULL;
CREATE TRIGGER c_items_card_facts_insert BEFORE INSERT ON c_items WHEN NEW.card_charge_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM c_card_charges ch WHERE ch.id=NEW.card_charge_id AND ch.item_id=NEW.id AND ch.amount_minor=NEW.amount_minor AND ch.descriptor=NEW.merchant AND COALESCE(ch.transaction_on,ch.posted_on)=NEW.spent_on AND NEW.kind='receipt' AND NEW.original_minor IS NULL)
  BEGIN SELECT RAISE(ABORT, 'a card expense keeps its statement facts'); END;
CREATE TRIGGER c_items_card_facts_update BEFORE UPDATE OF card_charge_id, kind, spent_on, merchant, amount_minor, original_minor, original_currency ON c_items WHEN OLD.card_charge_id IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'a card expense keeps its statement facts'); END;
