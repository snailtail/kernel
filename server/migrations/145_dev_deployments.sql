-- Dev platforms (part 2 of #32): deployments, deployment targets mapped to CIs and services, standard changes
-- registered by production deploys, and the change's status posted back on pull requests.
ALTER TABLE dev_items DROP CONSTRAINT dev_items_item_type_check;
ALTER TABLE dev_items ADD CONSTRAINT dev_items_item_type_check CHECK (item_type IN ('pull_request', 'issue', 'commit', 'workflow_run', 'release', 'deployment'));

-- Where a repository deploys to: (repository or project, environment) → the CIs and services it changes. A target
-- marked production may register a standard change from a pre-approved template, but only when an admin turned it on.
CREATE TABLE dev_deploy_targets (
  id              serial PRIMARY KEY,
  source_id       int NOT NULL REFERENCES dev_sources(id) ON DELETE CASCADE,
  repo            text NOT NULL,
  environment     text NOT NULL,
  ci_refs         text[] NOT NULL DEFAULT '{}',
  production      boolean NOT NULL DEFAULT false,
  register_change boolean NOT NULL DEFAULT false,
  template_id     int REFERENCES change_templates(id),
  created_by      int REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT register_change OR (production AND template_id IS NOT NULL))
);
CREATE UNIQUE INDEX dev_deploy_targets_key ON dev_deploy_targets (source_id, lower(repo), lower(environment));

-- A change registered by a deployment, once per platform deployment: the same deploy delivered twice is one change.
ALTER TABLE changes ADD COLUMN source_key text;
CREATE UNIQUE INDEX changes_source_key ON changes (source_key) WHERE source_key IS NOT NULL;

-- Status back on pull requests (opt-in per source): a separate token that may only write commit statuses, so reading
-- never needs write access.
ALTER TABLE dev_sources ADD COLUMN status_token text;
ALTER TABLE dev_sources ADD COLUMN post_status boolean NOT NULL DEFAULT false;
