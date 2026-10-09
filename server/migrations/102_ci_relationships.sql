-- CI relationships, services and groups (#17).
-- Each relationship is stored once, in its defined direction. `propagation` says which way an outage travels:
--   forward: `from` relies on `to` (to down => from affected), e.g. vm runs_on host
--   reverse: `to` relies on `from` (from down => to affected), e.g. component member_of service
CREATE TABLE ci_relationship_types (
  name          text PRIMARY KEY,
  label         text NOT NULL,
  inverse_label text NOT NULL,
  propagation   text NOT NULL CHECK (propagation IN ('forward', 'reverse'))
);
INSERT INTO ci_relationship_types (name, label, inverse_label, propagation) VALUES
  ('runs_on',      'runs on',       'hosts',           'forward'),
  ('depends_on',   'depends on',    'is used by',      'forward'),
  ('uses_database','uses database', 'is database for', 'forward'),
  ('connects_to',  'connects to',   'is connected from','forward'),
  ('contains',     'contains',      'is part of',      'forward'),
  ('member_of',    'is part of service', 'has component', 'reverse');

CREATE TABLE ci_relationships (
  id            serial PRIMARY KEY,
  from_ci       int NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  to_ci         int NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  type          text NOT NULL REFERENCES ci_relationship_types(name),
  -- NULL for relationships added by hand; otherwise the connector that discovered it (and alone may remove it).
  source_system text,
  created_by    int REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (from_ci <> to_ci),
  UNIQUE (from_ci, to_ci, type)
);
CREATE INDEX ci_relationships_to_idx ON ci_relationships (to_ci);
CREATE INDEX ci_relationships_source_idx ON ci_relationships (source_system) WHERE source_system IS NOT NULL;

-- Named sets of CIs with a purpose; members are added by hand and/or matched by rules.
CREATE TABLE ci_groups (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  purpose     text NOT NULL DEFAULT 'other' CHECK (purpose IN ('service', 'flow', 'billing', 'monitoring', 'maintenance', 'other')),
  description text NOT NULL DEFAULT '',
  -- { "match": "all" | "any", "conditions": [{ "field": "tag", "op": "eq", "value": "app=payroll" }] }
  rules       jsonb NOT NULL DEFAULT '{"match":"all","conditions":[]}',
  created_by  int REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ci_group_members (
  group_id int NOT NULL REFERENCES ci_groups(id) ON DELETE CASCADE,
  ci_id    int NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  added_by int REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, ci_id)
);
CREATE INDEX ci_group_members_ci_idx ON ci_group_members (ci_id);
