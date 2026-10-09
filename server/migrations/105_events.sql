-- Monitoring and event management (#30). Events are normalised and deduplicated into alerts on
-- (source, CI or host hint, check). Raw events are kept briefly; alerts and daily aggregates are kept for trends.
-- No raw webhook payloads are stored.

CREATE TABLE event_sources (
  id               serial PRIMARY KEY,
  name             text NOT NULL UNIQUE,
  kind             text NOT NULL CHECK (kind IN ('generic', 'alertmanager', 'uptime_kuma', 'azure_monitor', 'op5')),
  token_hash       text NOT NULL,
  token_prefix     text NOT NULL,
  -- Optional Standard Webhooks signing secret (encrypted) for the generic kind; when set, unsigned calls are refused.
  signing_secret   text,
  -- The CMDB source system used to resolve CIs by id (e.g. 'Azure' resource ids, 'OP5' host names).
  ci_source_system text NOT NULL DEFAULT '',
  enabled          boolean NOT NULL DEFAULT true,
  created_by       int REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_received_at timestamptz,
  received_count   bigint NOT NULL DEFAULT 0,
  rejected_count   bigint NOT NULL DEFAULT 0
);

CREATE TABLE event_rules (
  id                   serial PRIMARY KEY,
  name                 text NOT NULL UNIQUE,
  enabled              boolean NOT NULL DEFAULT true,
  position             int NOT NULL DEFAULT 100,
  -- Allowlisted conditions, see events.ts (ruleConditionsSchema); never SQL or regex.
  conditions           jsonb NOT NULL DEFAULT '{}',
  -- What to do: open (or group into) an incident.
  impact               smallint NOT NULL DEFAULT 2 CHECK (impact BETWEEN 1 AND 3),
  urgency              smallint NOT NULL DEFAULT 2 CHECK (urgency BETWEEN 1 AND 3),
  assignment_group     text NOT NULL DEFAULT '',
  group_by             text NOT NULL DEFAULT 'service' CHECK (group_by IN ('service', 'ci', 'rule')),
  group_window_minutes int NOT NULL DEFAULT 60 CHECK (group_window_minutes BETWEEN 1 AND 1440),
  max_incidents_per_hour int NOT NULL DEFAULT 5 CHECK (max_incidents_per_hour BETWEEN 1 AND 100),
  auto_resolve         boolean NOT NULL DEFAULT false,
  -- An incident is only auto-resolved after all its alerts stayed clear this long (flapping protection).
  hold_down_minutes    int NOT NULL DEFAULT 15 CHECK (hold_down_minutes BETWEEN 0 AND 1440),
  created_by           int REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
  id              bigserial PRIMARY KEY,
  source          text NOT NULL,
  ci_id           int REFERENCES configuration_items(id) ON DELETE SET NULL,
  -- Host/resource name when no CI matched (kept for mapping later).
  ci_hint         text NOT NULL DEFAULT '',
  -- The dedupe identity of the CI part: 'ci:<id>', 'host:<hint>' or '-'.
  dedupe_ci       text NOT NULL,
  check_key       text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('info', 'warning', 'minor', 'major', 'critical')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  message         text NOT NULL DEFAULT '',
  source_url      text NOT NULL DEFAULT '',
  count           int NOT NULL DEFAULT 1,
  flap_count      int NOT NULL DEFAULT 0,
  first_seen      timestamptz NOT NULL,
  last_seen       timestamptz NOT NULL,
  -- The occurred_at of the last state change, so replayed or out-of-order events never move state backwards.
  state_at        timestamptz NOT NULL,
  cleared_at      timestamptz,
  acknowledged_by int REFERENCES users(id),
  acknowledged_at timestamptz,
  suppressed      text NOT NULL DEFAULT '',
  rule_id         int REFERENCES event_rules(id) ON DELETE SET NULL,
  incident_id     int REFERENCES incidents(id) ON DELETE SET NULL,
  problem_id      int REFERENCES problems(id) ON DELETE SET NULL,
  candidate_dismissed boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- At most one open alert per identity: concurrent duplicates collapse via ON CONFLICT.
CREATE UNIQUE INDEX alerts_open_identity ON alerts (source, dedupe_ci, check_key) WHERE status = 'open';
CREATE INDEX alerts_identity_idx ON alerts (source, dedupe_ci, check_key, cleared_at DESC);
CREATE INDEX alerts_ci_idx ON alerts (ci_id, last_seen DESC);
CREATE INDEX alerts_incident_idx ON alerts (incident_id) WHERE incident_id IS NOT NULL;
CREATE INDEX alerts_open_idx ON alerts (severity, last_seen DESC) WHERE status = 'open';

-- Raw (normalised) events, purged after the retention period.
CREATE TABLE events (
  id              bigserial PRIMARY KEY,
  alert_id        bigint REFERENCES alerts(id) ON DELETE CASCADE,
  source          text NOT NULL,
  source_event_id text NOT NULL DEFAULT '',
  severity        text NOT NULL,
  message         text NOT NULL DEFAULT '',
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  outcome         text NOT NULL DEFAULT ''
);
CREATE INDEX events_received_idx ON events (received_at);
CREATE INDEX events_alert_idx ON events (alert_id, occurred_at DESC);

-- Kept long after raw events are purged: trends per CI and source.
CREATE TABLE event_daily (
  day      date NOT NULL,
  source   text NOT NULL,
  ci_id    int NOT NULL DEFAULT 0,
  severity text NOT NULL,
  count    int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, ci_id, severity)
);

-- A window covers a CI, a service (and what it depends on) or a CI group. The covered CIs are resolved when the
-- window is created and stored, so suppression is a cheap lookup and the scope is visible and stable.
CREATE TABLE maintenance_windows (
  id         serial PRIMARY KEY,
  ci_id      int REFERENCES configuration_items(id) ON DELETE CASCADE,
  group_id   int REFERENCES ci_groups(id) ON DELETE CASCADE,
  include_dependencies boolean NOT NULL DEFAULT false,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  reason     text NOT NULL DEFAULT '',
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK ((ci_id IS NULL) <> (group_id IS NULL))
);
CREATE TABLE maintenance_window_cis (
  window_id int NOT NULL REFERENCES maintenance_windows(id) ON DELETE CASCADE,
  ci_id     int NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  PRIMARY KEY (window_id, ci_id)
);
CREATE INDEX maintenance_window_cis_ci_idx ON maintenance_window_cis (ci_id);

-- Incidents opened by rules remember the rule, for storm protection and auto-resolve.
ALTER TABLE incidents ADD COLUMN event_rule_id int REFERENCES event_rules(id) ON DELETE SET NULL;
ALTER TABLE incidents ADD COLUMN event_group_key text;
CREATE INDEX incidents_event_group_idx ON incidents (event_rule_id, event_group_key, created_at DESC) WHERE event_rule_id IS NOT NULL;

INSERT INTO settings (key, value) VALUES ('event_retention', '{"raw_days": 14, "closed_alert_days": 180, "reopen_window_minutes": 15}')
ON CONFLICT (key) DO NOTHING;

-- Message ids of signed webhook calls seen recently: a replayed call within the timestamp window is refused.
CREATE TABLE event_hook_messages (
  source_id   int NOT NULL REFERENCES event_sources(id) ON DELETE CASCADE,
  message_id  text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, message_id)
);
