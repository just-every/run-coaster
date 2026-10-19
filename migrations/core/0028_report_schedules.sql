-- Scheduled report delivery (REPORT-002): finance or the owner schedules a report
-- for chosen readers (a link by default; the owner may opt a schedule in to the
-- figures as a CSV attachment); the hourly run claims each schedule's period once (the
-- delivery row) before sending, and records what the mail provider answered.
CREATE TABLE c_report_schedules (
  id TEXT PRIMARY KEY,
  report TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('last-business-day', 'first-business-day')),
  recipients TEXT NOT NULL CHECK (json_valid(recipients)),
  include_figures INTEGER NOT NULL DEFAULT 0 CHECK (include_figures IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  stopped_by TEXT,
  stopped_at TEXT
);
CREATE TABLE c_report_deliveries (
  schedule_id TEXT NOT NULL REFERENCES c_report_schedules(id),
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  recipients TEXT NOT NULL CHECK (json_valid(recipients)),
  PRIMARY KEY (schedule_id, period_from)
);
CREATE TRIGGER c_report_deliveries_append_only BEFORE UPDATE ON c_report_deliveries BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
CREATE TRIGGER c_report_deliveries_no_delete BEFORE DELETE ON c_report_deliveries BEGIN SELECT RAISE(ABORT, 'claim history is permanent'); END;
