-- Service catalogue and service level management (#43): business-hours calendars, SLAs with response and
-- resolution targets per priority, and SLA clocks on incidents that pause while on hold.
CREATE TABLE business_calendars (
  id             serial PRIMARY KEY,
  name           text NOT NULL UNIQUE,
  timezone       text NOT NULL DEFAULT 'Europe/Stockholm',
  -- Open hours per ISO weekday (1 = Monday … 7 = Sunday) as [start, end] minutes after midnight; empty = closed.
  -- always = true means 24/7 and ignores hours and holidays.
  always         boolean NOT NULL DEFAULT false,
  hours          jsonb NOT NULL DEFAULT '{}',
  -- Public holidays generated for this country (currently 'SE'), in addition to calendar_holidays.
  holiday_preset text CHECK (holiday_preset IN ('SE')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE calendar_holidays (
  calendar_id int NOT NULL REFERENCES business_calendars(id) ON DELETE CASCADE,
  day         date NOT NULL,
  name        text NOT NULL DEFAULT '',
  PRIMARY KEY (calendar_id, day)
);
INSERT INTO business_calendars (name, always) VALUES ('24/7', true);
INSERT INTO business_calendars (name, timezone, hours, holiday_preset) VALUES
  ('Office hours (Sweden)', 'Europe/Stockholm',
   '{"1": [[480, 1020]], "2": [[480, 1020]], "3": [[480, 1020]], "4": [[480, 1020]], "5": [[480, 1020]]}', 'SE');

CREATE TABLE slas (
  id                  serial PRIMARY KEY,
  name                text NOT NULL UNIQUE,
  description         text NOT NULL DEFAULT '',
  calendar_id         int NOT NULL REFERENCES business_calendars(id),
  -- Targets in business minutes per priority, e.g. {"1": 15, "2": 30, …}; a missing priority has no target.
  response_minutes    jsonb NOT NULL DEFAULT '{}',
  resolution_minutes  jsonb NOT NULL DEFAULT '{}',
  availability_target numeric(6, 3),
  is_default          boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX slas_one_default ON slas (is_default) WHERE is_default;
-- One SLA that works out of the box: P1/P2 around the clock, the rest in office hours would need two SLAs, so the
-- default is simply 24/7 with targets per priority.
INSERT INTO slas (name, description, calendar_id, response_minutes, resolution_minutes, is_default)
SELECT 'Standard', 'Default service level for incidents', id,
       '{"1": 15, "2": 30, "3": 240, "4": 480, "5": 1440}', '{"1": 240, "2": 480, "3": 2880, "4": 7200, "5": 14400}', true
FROM business_calendars WHERE name = '24/7';

-- Service catalogue fields (services are configuration items of class 'service').
ALTER TABLE configuration_items ADD COLUMN sla_id int REFERENCES slas(id) ON DELETE SET NULL;
ALTER TABLE configuration_items ADD COLUMN user_description text NOT NULL DEFAULT '';
ALTER TABLE configuration_items ADD COLUMN how_to_get_help text NOT NULL DEFAULT '';
ALTER TABLE configuration_items ADD COLUMN in_catalogue boolean NOT NULL DEFAULT false;

-- SLA clock on incidents: the SLA in force, business minutes spent on hold, and warnings already raised.
-- The clock: business minutes paused (on hold, or resolved before a reopen) plus the start of the current pause;
-- due and breach times are stored for queries ("breaching soon", reports) and recomputed on every state change.
ALTER TABLE incidents ADD COLUMN sla_id int REFERENCES slas(id) ON DELETE SET NULL;
ALTER TABLE incidents ADD COLUMN sla_paused_minutes int NOT NULL DEFAULT 0;
ALTER TABLE incidents ADD COLUMN sla_paused_since timestamptz;
ALTER TABLE incidents ADD COLUMN response_due_at timestamptz;
ALTER TABLE incidents ADD COLUMN resolution_due_at timestamptz;
ALTER TABLE incidents ADD COLUMN response_breached_at timestamptz;
ALTER TABLE incidents ADD COLUMN resolution_breached_at timestamptz;
CREATE INDEX incidents_resolution_due_idx ON incidents (resolution_due_at) WHERE status NOT IN ('resolved', 'closed') AND sla_paused_since IS NULL;

-- Each warning (75 %) and breach fires once per incident and target, whatever restarts or replicas do.
CREATE TABLE sla_events (
  incident_id int NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  target      text NOT NULL CHECK (target IN ('response', 'resolution')),
  kind        text NOT NULL CHECK (kind IN ('warning', 'breach')),
  fired_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, target, kind)
);
ALTER TABLE incident_activity DROP CONSTRAINT incident_activity_kind_check;
ALTER TABLE incident_activity ADD CONSTRAINT incident_activity_kind_check
  CHECK (kind IN ('created', 'comment', 'communication', 'status', 'update', 'link', 'sla'));
