CREATE TABLE c_notification_preferences (
  recipient TEXT PRIMARY KEY,
  timezone TEXT NOT NULL,
  quiet_from INTEGER NOT NULL CHECK(quiet_from BETWEEN 0 AND 23),
  quiet_until INTEGER NOT NULL CHECK(quiet_until BETWEEN 0 AND 23),
  submission TEXT NOT NULL CHECK(submission IN ('immediate','digest')),
  decision TEXT NOT NULL CHECK(decision IN ('immediate','digest')),
  returned TEXT NOT NULL CHECK(returned IN ('immediate','digest')),
  reminder TEXT NOT NULL CHECK(reminder IN ('immediate','digest')),
  updated_at TEXT NOT NULL
);
CREATE TABLE c_notification_deliveries (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('immediate','digest')),
  bucket TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('attempting','accepted','failed','unconfigured')),
  attempted_at TEXT NOT NULL,
  provider_status TEXT,
  event_count INTEGER NOT NULL CHECK(event_count > 0),
  UNIQUE(recipient,bucket)
);
CREATE TABLE c_notification_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('submission','decision','return','reminder')),
  mode TEXT NOT NULL CHECK(mode IN ('immediate','digest')),
  created_at TEXT NOT NULL,
  task_key TEXT,
  delivery_id TEXT REFERENCES c_notification_deliveries(id),
  cancelled_at TEXT,
  UNIQUE(event_id,recipient)
);
CREATE INDEX c_notification_pending ON c_notification_events(recipient,delivery_id,cancelled_at);
-- Queue only explicitly enabled personal email preferences, in the same transaction as the claim history.
CREATE TRIGGER c_notify_claim AFTER INSERT ON c_events
WHEN NEW.action IN ('claim-submitted','claim-resubmitted','claim-step-approved','claim-approved','claim-rejected','claim-returned')
BEGIN
  INSERT INTO c_notification_events(id,event_id,recipient,claim_id,revision,kind,mode,created_at)
  SELECT NEW.id||':'||p.recipient,NEW.id,p.recipient,c.id,c.revision,
    CASE WHEN NEW.action IN ('claim-submitted','claim-resubmitted','claim-step-approved') THEN 'submission' WHEN NEW.action='claim-returned' THEN 'return' ELSE 'decision' END,
    CASE WHEN NEW.action IN ('claim-submitted','claim-resubmitted','claim-step-approved') THEN p.submission WHEN NEW.action='claim-returned' THEN p.returned ELSE p.decision END,NEW.at
  FROM c_claims c JOIN c_notification_preferences p
  ON (NEW.action IN ('claim-submitted','claim-resubmitted','claim-step-approved') AND c.status='submitted' AND
    (p.recipient=c.approver_email OR EXISTS(SELECT 1 FROM c_workflow_tasks t WHERE t.kind='claim' AND t.record_id=c.id AND t.revision=c.revision AND t.status='waiting' AND t.email=p.recipient)))
    OR (NEW.action IN ('claim-approved','claim-rejected','claim-returned') AND p.recipient=c.employee_email)
  WHERE c.id=NEW.claim_id;
END;
