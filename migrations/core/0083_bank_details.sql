-- PAY-002: employee bank details held as a provider token (sealed) and the last four digits only, with change protection.
CREATE TABLE c_bank_providers (
  provider TEXT PRIMARY KEY CHECK(provider IN ('plaid','stripe')),
  credentials_sealed TEXT NOT NULL,
  connected_by TEXT NOT NULL,
  connected_at TEXT NOT NULL
);
CREATE TABLE c_bank_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  hold_days INTEGER NOT NULL CHECK(hold_days BETWEEN 1 AND 30),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL
);
INSERT INTO c_bank_settings(id,hold_days,set_by,set_at) VALUES(1,2,'default','2026-10-27T00:00:00.000Z');
CREATE TABLE c_bank_accounts (
  id TEXT PRIMARY KEY,
  member_email TEXT NOT NULL REFERENCES c_members(email),
  provider TEXT NOT NULL CHECK(provider IN ('plaid','stripe')),
  method TEXT NOT NULL CHECK(method IN ('instant','microdeposit')),
  state TEXT NOT NULL CHECK(state IN ('pending','active','replaced','abandoned')),
  token_sealed TEXT,
  last4 TEXT NOT NULL CHECK(length(last4)=4 AND last4 NOT GLOB '*[^0-9]*'),
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT,
  replaced_at TEXT,
  previous_id TEXT REFERENCES c_bank_accounts(id),
  hold_days INTEGER,
  hold_until TEXT,
  hold_released_at TEXT,
  CHECK((state IN ('pending','active'))=(token_sealed IS NOT NULL)),
  CHECK(provider<>'plaid' OR method='instant'),
  CHECK((state IN ('active','replaced'))=(verified_at IS NOT NULL)),
  CHECK((hold_until IS NULL)=(hold_days IS NULL)),
  CHECK(hold_released_at IS NULL OR hold_until IS NOT NULL)
);
CREATE UNIQUE INDEX c_bank_one_active ON c_bank_accounts(member_email) WHERE state='active';
CREATE UNIQUE INDEX c_bank_one_pending ON c_bank_accounts(member_email) WHERE state='pending';
-- An account's identity, its last four and its hold are evidence: only the state moves, the replaced or abandoned token is discarded,
-- and the hold is released once by the hourly run.
CREATE TRIGGER c_bank_evidence BEFORE UPDATE ON c_bank_accounts
WHEN NOT EXISTS(SELECT 1 FROM c_erasing) AND (NEW.id<>OLD.id OR NEW.member_email<>OLD.member_email OR NEW.provider<>OLD.provider OR NEW.method<>OLD.method
  OR NEW.last4<>OLD.last4 OR NEW.label<>OLD.label OR NEW.created_at<>OLD.created_at
  OR NOT (NEW.state=OLD.state OR (OLD.state='pending' AND NEW.state IN ('active','abandoned')) OR (OLD.state='active' AND NEW.state='replaced'))
  OR (NEW.token_sealed IS NOT OLD.token_sealed AND NOT (NEW.token_sealed IS NULL AND NEW.state IN ('replaced','abandoned')))
  OR (OLD.state<>'pending' AND (NEW.verified_at IS NOT OLD.verified_at OR NEW.previous_id IS NOT OLD.previous_id OR NEW.hold_days IS NOT OLD.hold_days OR NEW.hold_until IS NOT OLD.hold_until))
  OR (OLD.hold_released_at IS NOT NULL AND NEW.hold_released_at IS NOT OLD.hold_released_at)
  OR (NEW.replaced_at IS NOT OLD.replaced_at AND NEW.state<>'replaced'))
BEGIN SELECT RAISE(ABORT,'Bank account evidence is immutable'); END;
CREATE TRIGGER c_bank_no_delete BEFORE DELETE ON c_bank_accounts WHEN NOT EXISTS(SELECT 1 FROM c_erasing)
BEGIN SELECT RAISE(ABORT,'Bank account evidence is immutable'); END;
