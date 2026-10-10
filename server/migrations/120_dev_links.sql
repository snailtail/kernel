-- Dev platform links (#32): pull requests, issues, commits, workflow runs and releases on GitHub (Azure DevOps and
-- GitLab later), linked to problems, changes and incidents, with their live status.
CREATE TABLE dev_sources (
  id             serial PRIMARY KEY,
  name           text NOT NULL UNIQUE,
  platform       text NOT NULL DEFAULT 'github' CHECK (platform IN ('github')),
  -- Webhook secret (encrypted): GitHub signs each delivery with it (X-Hub-Signature-256).
  webhook_secret text NOT NULL,
  -- Optional read-only API token (encrypted) for titles and status of private repositories.
  api_token      text,
  api_base       text NOT NULL DEFAULT 'https://api.github.com',
  -- Repositories this source accepts deliveries for ("owner/name"): only these may link to Kernel records.
  repositories   text[] NOT NULL DEFAULT '{}',
  enabled        boolean NOT NULL DEFAULT true,
  received_count int NOT NULL DEFAULT 0,
  rejected_count int NOT NULL DEFAULT 0,
  last_received_at timestamptz,
  created_by     int REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dev_items (
  id         serial PRIMARY KEY,
  platform   text NOT NULL DEFAULT 'github',
  repo       text NOT NULL,
  item_type  text NOT NULL CHECK (item_type IN ('pull_request', 'issue', 'commit', 'workflow_run', 'release')),
  key        text NOT NULL,
  url        text NOT NULL,
  title      text NOT NULL DEFAULT '',
  state      text NOT NULL DEFAULT 'unknown',
  checks     text,
  author     text NOT NULL DEFAULT '',
  environment text NOT NULL DEFAULT '',
  data       jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, repo, item_type, key)
);

CREATE TABLE dev_item_links (
  dev_item_id int NOT NULL REFERENCES dev_items(id) ON DELETE CASCADE,
  record_type text NOT NULL CHECK (record_type IN ('problem', 'change', 'incident')),
  record_ref  text NOT NULL,
  linked_by   int REFERENCES users(id),
  via         text NOT NULL DEFAULT 'manual' CHECK (via IN ('manual', 'webhook', 'mcp')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dev_item_id, record_type, record_ref)
);
CREATE INDEX dev_item_links_record_idx ON dev_item_links (record_type, record_ref);

-- Links follow their record's visibility (#53); dev items are only seen through a visible link.
ALTER TABLE dev_item_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_item_links FORCE ROW LEVEL SECURITY;
CREATE POLICY dev_item_links_visible ON dev_item_links USING (
  CASE record_type
    WHEN 'problem' THEN EXISTS (SELECT 1 FROM problems p WHERE p.ref = record_ref)
    WHEN 'incident' THEN EXISTS (SELECT 1 FROM incidents p WHERE p.ref = record_ref)
    WHEN 'change' THEN EXISTS (SELECT 1 FROM changes p WHERE p.ref = record_ref)
  END);
ALTER TABLE dev_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_items FORCE ROW LEVEL SECURITY;
-- An item is visible through a link the viewer can see, or while it is linked to nothing (just created). A PR whose
-- only link is a restricted record stays hidden: its title often names the problem.
CREATE FUNCTION kernel_dev_item_linked(item int) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM dev_item_links WHERE dev_item_id = item)
$$;
CREATE POLICY dev_items_visible ON dev_items USING (
  EXISTS (SELECT 1 FROM dev_item_links l WHERE l.dev_item_id = id) OR NOT kernel_dev_item_linked(id));

-- Deliveries already processed (X-GitHub-Delivery), so a replayed delivery does nothing; kept for a day.
CREATE TABLE dev_deliveries (
  source_id   int NOT NULL REFERENCES dev_sources(id) ON DELETE CASCADE,
  delivery_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, delivery_id)
);
ALTER TABLE dev_sources ADD CONSTRAINT dev_sources_repositories CHECK (cardinality(repositories) > 0);
