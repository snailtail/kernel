-- External systems with URL templates per record kind, e.g. {"incident": "https://sn.example/incident.do?number={ref}"}
CREATE TABLE external_systems (
  id            serial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  url_templates jsonb NOT NULL DEFAULT '{}',
  active        boolean NOT NULL DEFAULT true
);

-- Incidents and events reported by integrations. Unlinked records feed the problem candidate list.
CREATE TABLE external_records (
  id          serial PRIMARY KEY,
  system      text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('incident', 'event')),
  reference   text NOT NULL,
  service     text NOT NULL DEFAULT '',
  category    text NOT NULL DEFAULT '',
  summary     text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  problem_id  int REFERENCES problems(id) ON DELETE SET NULL,
  dismissed   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (system, kind, reference)
);
CREATE INDEX external_records_candidates_idx ON external_records (service, occurred_at) WHERE problem_id IS NULL AND NOT dismissed;

CREATE TABLE settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
INSERT INTO settings (key, value) VALUES ('candidate_rule', '{"min_records": 5, "window_days": 7}');

-- Integration accounts can report records and link them, nothing else.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'problem_manager', 'analyst', 'viewer', 'integration'));
