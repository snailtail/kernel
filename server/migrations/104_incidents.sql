-- Incident management (#28): native incidents alongside links to incidents in other tools (external_records and
-- problem_links keep working unchanged; they are references to records that live elsewhere).
CREATE SEQUENCE incident_ref_seq;

CREATE TABLE incidents (
  id               serial PRIMARY KEY,
  ref              text NOT NULL UNIQUE DEFAULT 'INC' || lpad(nextval('incident_ref_seq')::text, 6, '0'),
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'on_hold', 'resolved', 'closed')),
  impact           smallint NOT NULL DEFAULT 3 CHECK (impact BETWEEN 1 AND 3),
  urgency          smallint NOT NULL DEFAULT 3 CHECK (urgency BETWEEN 1 AND 3),
  priority         smallint GENERATED ALWAYS AS (impact + urgency - 1) STORED,
  category_id      int REFERENCES categories(id),
  assignment_group text NOT NULL DEFAULT '',
  assignee_id      int REFERENCES users(id),
  reporter         text NOT NULL DEFAULT '',
  source           text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'event', 'api', 'mcp')),
  is_major         boolean NOT NULL DEFAULT false,
  hold_reason      text NOT NULL DEFAULT '',
  resolution_code  text CHECK (resolution_code IN ('fixed', 'workaround', 'problem_fixed', 'no_fault_found', 'duplicate', 'cancelled')),
  resolution       text NOT NULL DEFAULT '',
  problem_id       int REFERENCES problems(id) ON DELETE SET NULL,
  reopen_count     int NOT NULL DEFAULT 0,
  -- Dismissed from problem candidates (it needs no problem).
  candidate_dismissed boolean NOT NULL DEFAULT false,
  created_by       int REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  responded_at     timestamptz,
  resolved_at      timestamptz,
  closed_at        timestamptz,
  search           tsvector GENERATED ALWAYS AS (to_tsvector('simple', ref || ' ' || title || ' ' || description || ' ' || assignment_group)) STORED
);
CREATE INDEX incidents_search_idx ON incidents USING gin (search);
CREATE INDEX incidents_open_idx ON incidents (status, priority) WHERE status NOT IN ('resolved', 'closed');
CREATE INDEX incidents_problem_idx ON incidents (problem_id) WHERE problem_id IS NOT NULL;
CREATE INDEX incidents_assignee_idx ON incidents (assignee_id) WHERE status NOT IN ('resolved', 'closed');

CREATE TABLE incident_cis (
  incident_id int NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  ci_id       int NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  added_by    int REFERENCES users(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, ci_id)
);
CREATE INDEX incident_cis_ci_idx ON incident_cis (ci_id);

CREATE TABLE incident_activity (
  id          serial PRIMARY KEY,
  incident_id int NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id     int REFERENCES users(id),
  -- 'communication' is a stakeholder update during a major incident.
  kind        text NOT NULL CHECK (kind IN ('created', 'comment', 'communication', 'status', 'update', 'link')),
  body        text NOT NULL DEFAULT '',
  data        jsonb NOT NULL DEFAULT '{}',
  channel     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_activity_incident_idx ON incident_activity (incident_id, created_at);

CREATE TABLE incident_links (
  id          serial PRIMARY KEY,
  incident_id int NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('incident', 'event', 'change', 'document')),
  reference   text NOT NULL,
  system      text NOT NULL DEFAULT '',
  url         text NOT NULL DEFAULT '',
  note        text NOT NULL DEFAULT '',
  created_by  int REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, kind, reference)
);
