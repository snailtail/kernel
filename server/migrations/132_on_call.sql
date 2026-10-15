-- On-call (#111, decided in #42): integrate with the paging tool rather than reinvent it. Each team may have one
-- paging target (PagerDuty, Opsgenie, Grafana OnCall, a signed webhook, or a simple built-in weekly rotation), a rule
-- for when an incident pages it, and an outbox of pages that a worker delivers outside any transaction.
CREATE TABLE paging_targets (
  id           serial PRIMARY KEY,
  team_id      int NOT NULL UNIQUE REFERENCES teams(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('pagerduty', 'opsgenie', 'grafana_oncall', 'webhook', 'rotation')),
  -- Non-secret settings: API region, schedule or escalation policy for "who is on call", a webhook URL.
  config       jsonb NOT NULL DEFAULT '{}',
  -- Routing key, API key or signing secret: encrypted, never returned.
  secret       text,
  -- When an incident pages the team: priorities, major incidents, services, business hours.
  rule         jsonb NOT NULL DEFAULT '{"priorities": [1, 2], "major": true, "services": [], "hours": "always"}',
  private_allow text[] NOT NULL DEFAULT '{}',
  -- The inbound webhook (acknowledged by X) is authenticated with a token shown once; only its hash is kept.
  inbound_token_hash text,
  enabled      boolean NOT NULL DEFAULT true,
  created_by   int REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pages (
  id            bigserial PRIMARY KEY,
  incident_id   int NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  team_id       int REFERENCES teams(id) ON DELETE SET NULL,
  target_id     int REFERENCES paging_targets(id) ON DELETE SET NULL,
  kind          text NOT NULL,
  action        text NOT NULL CHECK (action IN ('trigger', 'acknowledge', 'resolve')),
  reason        text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  attempts      int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until   timestamptz,
  response_code int,
  error         text NOT NULL DEFAULT '',
  -- Who the built-in rotation paged.
  paged_user_id int REFERENCES users(id),
  created_by    int REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);
CREATE INDEX pages_incident_idx ON pages (incident_id, created_at);
CREATE INDEX pages_due_idx ON pages (next_attempt_at) WHERE status = 'queued';

-- The fallback rotation, for teams without a paging tool: members in turn, handed over once a week.
CREATE TABLE rotations (
  team_id          int PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  members          int[] NOT NULL DEFAULT '{}',
  -- ISO weekday (1 = Monday) and minute of the day the next person takes over, in the time zone.
  handover_dow     int NOT NULL DEFAULT 1 CHECK (handover_dow BETWEEN 1 AND 7),
  handover_minute  int NOT NULL DEFAULT 540 CHECK (handover_minute BETWEEN 0 AND 1439),
  timezone         text NOT NULL DEFAULT 'Europe/Stockholm',
  -- The week the first member starts (any date in it).
  starts_on        date NOT NULL DEFAULT current_date,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rotation_overrides (
  id         serial PRIMARY KEY,
  team_id    int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    int NOT NULL REFERENCES users(id),
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL CHECK (ends_at > starts_at),
  reason     text NOT NULL DEFAULT '',
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rotation_overrides_team_idx ON rotation_overrides (team_id, ends_at);

-- Pages follow their incident's visibility (#53), like everything attached to a record.
ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages FORCE ROW LEVEL SECURITY;
CREATE POLICY pages_visible ON pages USING (EXISTS (SELECT 1 FROM incidents i WHERE i.id = incident_id));
