-- FEED-005 card statement reconciliation and liability clearing (statement-file door). A statement record is one card's
-- statement period read from a retained masked original; its differences are derived from that original and the card
-- charges, so only the finance person's resolutions and the closing ledger entries are stored. Closing is permanent.
CREATE TABLE c_card_statements (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES c_statement_files(id),
  card_id TEXT NOT NULL REFERENCES c_cards(id),
  period_start TEXT,
  period_end TEXT NOT NULL,
  opening_minor INTEGER NOT NULL,
  statement_minor INTEGER NOT NULL,
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_by TEXT,
  closed_at TEXT,
  UNIQUE (file_id, card_id),
  CHECK ((closed_at IS NULL) = (closed_by IS NULL))
);
CREATE UNIQUE INDEX c_card_statements_closed_period ON c_card_statements(card_id, period_end) WHERE closed_at IS NOT NULL;
CREATE TRIGGER c_card_statements_closed_permanent BEFORE UPDATE ON c_card_statements
  WHEN OLD.closed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM c_erasing)
  BEGIN SELECT RAISE(ABORT, 'a closed card statement is permanent'); END;
CREATE TRIGGER c_card_statements_keep_source BEFORE UPDATE OF id, file_id, card_id, period_start, period_end ON c_card_statements
  BEGIN SELECT RAISE(ABORT, 'a card statement keeps its source file, card and period'); END;
CREATE TRIGGER c_card_statements_no_delete BEFORE DELETE ON c_card_statements BEGIN SELECT RAISE(ABORT, 'a card statement is permanent'); END;

-- One resolution per statement line: a missing charge is added as a card expense or explained; a credit is acknowledged.
CREATE TABLE c_card_statement_resolutions (
  statement_id TEXT NOT NULL REFERENCES c_card_statements(id),
  line INTEGER NOT NULL CHECK (line > 0),
  resolution TEXT NOT NULL CHECK (resolution IN ('add', 'explain', 'credit')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  charge_id TEXT,
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  resolved_by TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  PRIMARY KEY (statement_id, line),
  CHECK (resolution = 'add' OR note <> '' OR (resolution = 'credit' AND charge_id IS NOT NULL))
);
CREATE TRIGGER c_card_statement_resolutions_open BEFORE INSERT ON c_card_statement_resolutions
  WHEN EXISTS(SELECT 1 FROM c_card_statements s WHERE s.id=NEW.statement_id AND s.closed_at IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'a closed card statement is permanent'); END;
CREATE TRIGGER c_card_statement_resolutions_permanent BEFORE UPDATE ON c_card_statement_resolutions
  WHEN NOT EXISTS(SELECT 1 FROM c_erasing)
  BEGIN SELECT RAISE(ABORT, 'a statement resolution is permanent'); END;
CREATE TRIGGER c_card_statement_resolutions_no_delete BEFORE DELETE ON c_card_statement_resolutions BEGIN SELECT RAISE(ABORT, 'a statement resolution is permanent'); END;

-- The native card liability ledger: one double entry per line, written once when its statement closes. ACCT-001 to
-- ACCT-003 will carry these entries to the connected ledger; until then the card account is read here.
CREATE TABLE c_card_ledger (
  id TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL REFERENCES c_card_statements(id),
  card_id TEXT NOT NULL REFERENCES c_cards(id),
  seq INTEGER NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL CHECK (kind IN ('opening', 'purchase', 'unmatched', 'credit', 'payment', 'fee', 'interest')),
  debit_account TEXT NOT NULL,
  credit_account TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  ref TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  posted_on TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  UNIQUE (statement_id, seq),
  CHECK (debit_account <> credit_account)
);
CREATE INDEX c_card_ledger_card ON c_card_ledger(card_id, posted_at, seq);
CREATE TRIGGER c_card_ledger_with_close BEFORE INSERT ON c_card_ledger
  WHEN NOT EXISTS(SELECT 1 FROM c_card_statements s WHERE s.id=NEW.statement_id AND s.card_id=NEW.card_id AND s.closed_at=NEW.posted_at)
  BEGIN SELECT RAISE(ABORT, 'ledger entries are written only when their statement closes'); END;
CREATE TRIGGER c_card_ledger_permanent BEFORE UPDATE ON c_card_ledger BEGIN SELECT RAISE(ABORT, 'a ledger entry is permanent'); END;
CREATE TRIGGER c_card_ledger_no_delete BEFORE DELETE ON c_card_ledger BEGIN SELECT RAISE(ABORT, 'a ledger entry is permanent'); END;
