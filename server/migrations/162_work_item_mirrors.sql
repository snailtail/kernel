-- Mirrored backlogs (#168, epic #164), part 1: a team keeps its backlog in Azure DevOps (GitHub and GitLab in part 2)
-- and Kernel mirrors it. Pointers, not copies (#33): the title, type, status, iteration, points, assignee and parent
-- come from the source and are read-only in Kernel; the description stays there. Kernel's own links, comments,
-- visibility and classification work as for native items.

-- One mirror per team; a team without one is native (the default).
CREATE TABLE work_item_mirrors (
  id               serial PRIMARY KEY,
  team_id          int NOT NULL UNIQUE REFERENCES teams(id) ON DELETE CASCADE,
  -- The dev source (#32) whose token, network settings and webhook the mirror uses.
  source_id        int NOT NULL REFERENCES dev_sources(id) ON DELETE CASCADE,
  -- One of the source's repositories entries: organisation/project on Azure DevOps.
  scope            text NOT NULL,
  -- Where in the scope the team's items are: an area path on Azure DevOps (the items under it); empty is all of it.
  area             text NOT NULL DEFAULT '',
  -- Adjustments to the source's default mapping: {"Feature": "epic"} and {"Resolved": "done"}, keyed by the source's
  -- names (case does not matter). A type mapped to "" is not mirrored.
  type_map         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(type_map) = 'object'),
  status_map       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(status_map) = 'object'),
  -- The periodic reconciliation, beside the webhook: never overlapping (a lease, as connectors have).
  schedule_minutes int NOT NULL DEFAULT 60 CHECK (schedule_minutes BETWEEN 5 AND 1440),
  next_run_at      timestamptz NOT NULL DEFAULT now(),
  running_until    timestamptz,
  -- The last reconciliation: status, counts and message.
  last_run         jsonb,
  enabled          boolean NOT NULL DEFAULT true,
  created_by       int REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Where a mirrored item lives. external_id is unique per source platform: "organisation#id" on Azure DevOps, whose ids
-- are unique per organisation. An item whose mirror was removed keeps its source and link, and is native again.
ALTER TABLE work_items
  ADD COLUMN source text CHECK (source IN ('azure_devops', 'github', 'gitlab')),
  ADD COLUMN external_id text,
  ADD COLUMN external_url text NOT NULL DEFAULT '',
  -- The source's iteration (sprint) path, shown as is; a sprint of the team with its last segment as name holds it.
  ADD COLUMN external_iteration text NOT NULL DEFAULT '',
  ADD COLUMN mirror_id int REFERENCES work_item_mirrors(id) ON DELETE SET NULL,
  ADD CHECK ((source IS NULL) = (external_id IS NULL));
CREATE UNIQUE INDEX work_items_external_idx ON work_items (source, external_id) WHERE source IS NOT NULL;
CREATE INDEX work_items_mirror_idx ON work_items (mirror_id) WHERE mirror_id IS NOT NULL;
