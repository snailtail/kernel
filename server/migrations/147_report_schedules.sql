-- Scheduled service reports (#54). A person asks for a service's report (or an organisation's services) monthly or
-- quarterly; each ended period is queued once per schedule and sent by email with the Markdown report attached.
CREATE TABLE report_schedules (
  id              serial PRIMARY KEY,
  user_id         int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_id      int REFERENCES configuration_items(id) ON DELETE CASCADE,
  organisation_id int REFERENCES organisations(id) ON DELETE CASCADE,
  frequency       text NOT NULL CHECK (frequency IN ('monthly', 'quarterly')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((service_id IS NULL) <> (organisation_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT (user_id, service_id, organisation_id, frequency)
);
CREATE INDEX report_schedules_service_idx ON report_schedules (service_id) WHERE service_id IS NOT NULL;

-- One row per schedule and period ("2026-09", "2026-Q3"): queuing twice changes nothing, so a period is sent once.
CREATE TABLE report_deliveries (
  id              bigserial PRIMARY KEY,
  schedule_id     int NOT NULL REFERENCES report_schedules(id) ON DELETE CASCADE,
  period          text NOT NULL,
  period_from     date NOT NULL,
  period_to       date NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  sent_at         timestamptz,
  error           text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, period)
);
CREATE INDEX report_deliveries_due_idx ON report_deliveries (next_attempt_at) WHERE status IN ('pending', 'sending');
