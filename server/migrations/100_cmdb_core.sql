-- CMDB core (#16): configuration items as pointers to where they really live, not copies of the source systems.
-- Services are nodes in the same table (class 'service', ref SVC…), so impact analysis walks one graph (#17).

CREATE TABLE ci_types (
  name       text PRIMARY KEY,
  label      text NOT NULL,
  class      text NOT NULL DEFAULT 'ci' CHECK (class IN ('ci', 'service')),
  -- [{ "key": "os", "label": "Operating system", "type": "string" | "number" }]
  attributes jsonb NOT NULL DEFAULT '[]',
  active     boolean NOT NULL DEFAULT true
);
INSERT INTO ci_types (name, label, class, attributes) VALUES
  ('physical_server', 'Physical server', 'ci', '[{"key":"os","label":"Operating system","type":"string"},{"key":"fqdn","label":"FQDN","type":"string"},{"key":"ip","label":"IP address","type":"string"},{"key":"cpu","label":"CPUs","type":"number"},{"key":"ram_gb","label":"RAM (GB)","type":"number"}]'),
  ('virtual_machine', 'Virtual machine', 'ci', '[{"key":"os","label":"Operating system","type":"string"},{"key":"fqdn","label":"FQDN","type":"string"},{"key":"ip","label":"IP address","type":"string"},{"key":"cpu","label":"vCPUs","type":"number"},{"key":"ram_gb","label":"RAM (GB)","type":"number"}]'),
  ('cloud_instance', 'Cloud instance', 'ci', '[{"key":"provider","label":"Provider","type":"string"},{"key":"region","label":"Region","type":"string"},{"key":"instance_type","label":"Instance type","type":"string"},{"key":"os","label":"Operating system","type":"string"}]'),
  ('container', 'Container', 'ci', '[{"key":"image","label":"Image","type":"string"},{"key":"namespace","label":"Namespace","type":"string"}]'),
  ('kubernetes_workload', 'Kubernetes workload', 'ci', '[{"key":"namespace","label":"Namespace","type":"string"},{"key":"kind","label":"Kind","type":"string"},{"key":"replicas","label":"Replicas","type":"number"}]'),
  ('cluster', 'Cluster', 'ci', '[{"key":"platform","label":"Platform","type":"string"},{"key":"version","label":"Version","type":"string"}]'),
  ('application', 'Application / system', 'ci', '[{"key":"version","label":"Version","type":"string"},{"key":"url","label":"URL","type":"string"}]'),
  ('database', 'Database', 'ci', '[{"key":"engine","label":"Engine","type":"string"},{"key":"version","label":"Version","type":"string"},{"key":"size_gb","label":"Size (GB)","type":"number"}]'),
  ('network_device', 'Network device', 'ci', '[{"key":"vendor","label":"Vendor","type":"string"},{"key":"model","label":"Model","type":"string"},{"key":"ip","label":"IP address","type":"string"}]'),
  ('storage', 'Storage', 'ci', '[{"key":"vendor","label":"Vendor","type":"string"},{"key":"capacity_tb","label":"Capacity (TB)","type":"number"}]'),
  ('other', 'Other', 'ci', '[]'),
  ('business_service', 'Business service', 'service', '[{"key":"customer","label":"Customer / cost centre","type":"string"},{"key":"hours","label":"Service hours","type":"string"}]'),
  ('technical_service', 'Technical service', 'service', '[{"key":"customer","label":"Customer / cost centre","type":"string"}]');

-- array_to_string is only STABLE; tags are plain text, so joining them is safe to declare IMMUTABLE for the index.
CREATE FUNCTION kernel_join_tags(text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string($1, ' ') $$;

CREATE SEQUENCE ci_ref_seq;
CREATE SEQUENCE service_ref_seq;

CREATE TABLE configuration_items (
  id          serial PRIMARY KEY,
  ref         text NOT NULL UNIQUE,
  class       text NOT NULL DEFAULT 'ci' CHECK (class IN ('ci', 'service')),
  name        text NOT NULL,
  ci_type     text NOT NULL REFERENCES ci_types(name),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('planned', 'active', 'maintenance', 'retired', 'missing')),
  environment text NOT NULL DEFAULT 'prod' CHECK (environment IN ('prod', 'test', 'dev', 'other')),
  criticality smallint NOT NULL DEFAULT 3 CHECK (criticality BETWEEN 1 AND 4),
  owner_id    int REFERENCES users(id),
  team        text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  tags        text[] NOT NULL DEFAULT '{}',
  attributes  jsonb NOT NULL DEFAULT '{}',
  created_by  int REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  search      tsvector GENERATED ALWAYS AS (
                to_tsvector('simple', ref || ' ' || name || ' ' || ci_type || ' ' || team || ' ' || description || ' ' || kernel_join_tags(tags))
              ) STORED
);
CREATE INDEX configuration_items_search_idx ON configuration_items USING gin (search);
CREATE INDEX configuration_items_type_idx ON configuration_items (class, ci_type);
CREATE INDEX configuration_items_name_idx ON configuration_items (lower(name));

-- Where a CI lives. One CI can be seen by several sources (e.g. vCenter and OP5).
CREATE TABLE ci_sources (
  id            serial PRIMARY KEY,
  ci_id         int NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  source_system text NOT NULL,
  source_id     text NOT NULL,
  source_url    text NOT NULL DEFAULT '',
  created_by    int REFERENCES users(id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system, source_id)
);
CREATE INDEX ci_sources_ci_idx ON ci_sources (ci_id);

CREATE TABLE ci_activity (
  id         serial PRIMARY KEY,
  ci_id      int NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  user_id    int REFERENCES users(id),
  kind       text NOT NULL CHECK (kind IN ('created', 'update', 'status', 'comment', 'link', 'source', 'relationship')),
  body       text NOT NULL DEFAULT '',
  data       jsonb NOT NULL DEFAULT '{}',
  channel    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ci_activity_ci_idx ON ci_activity (ci_id, created_at);

-- Links from a CI to records elsewhere (problems, incidents, changes in other tools, documentation).
CREATE TABLE ci_links (
  id         serial PRIMARY KEY,
  ci_id      int NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('incident', 'event', 'change', 'problem', 'document')),
  reference  text NOT NULL,
  system     text NOT NULL DEFAULT '',
  url        text NOT NULL DEFAULT '',
  note       text NOT NULL DEFAULT '',
  created_by int NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ci_id, kind, reference)
);
