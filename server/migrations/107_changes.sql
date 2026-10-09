-- Change enablement (#29): changes to CIs and services, authorised by a change authority, scheduled without
-- collisions or freezes, and reviewed. Problems raise changes for their fix; incidents shortly after a change on
-- what they depend on are flagged as possibly change-related.
CREATE SEQUENCE change_ref_seq;

CREATE TABLE change_templates (
  id                  serial PRIMARY KEY,
  name                text NOT NULL UNIQUE,
  description         text NOT NULL DEFAULT '',
  implementation_plan text NOT NULL DEFAULT '',
  test_plan           text NOT NULL DEFAULT '',
  backout_plan        text NOT NULL DEFAULT '',
  active              boolean NOT NULL DEFAULT true,
  created_by          int REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE changes (
  id                  serial PRIMARY KEY,
  ref                 text NOT NULL UNIQUE DEFAULT 'CHG' || lpad(nextval('change_ref_seq')::text, 6, '0'),
  title               text NOT NULL,
  description         text NOT NULL DEFAULT '',
  change_type         text NOT NULL DEFAULT 'normal' CHECK (change_type IN ('standard', 'normal', 'emergency')),
  template_id         int REFERENCES change_templates(id),
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'assess', 'authorize', 'scheduled', 'implementing', 'review', 'closed', 'rejected', 'cancelled')),
  -- The assessed risk; NULL means "use the computed risk".
  risk                text CHECK (risk IN ('low', 'medium', 'high')),
  planned_start       timestamptz,
  planned_end         timestamptz,
  actual_start        timestamptz,
  actual_end          timestamptz,
  implementation_plan text NOT NULL DEFAULT '',
  test_plan           text NOT NULL DEFAULT '',
  backout_plan        text NOT NULL DEFAULT '',
  outcome             text CHECK (outcome IN ('successful', 'failed', 'rolled_back')),
  review              text NOT NULL DEFAULT '',
  cancel_reason       text NOT NULL DEFAULT '',
  problem_id          int REFERENCES problems(id) ON DELETE SET NULL,
  assignee_id         int REFERENCES users(id),
  source              text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'api', 'mcp', 'pipeline')),
  created_by          int REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  CHECK (planned_end IS NULL OR planned_start IS NULL OR planned_end > planned_start),
  search              tsvector GENERATED ALWAYS AS (to_tsvector('simple', ref || ' ' || title || ' ' || description)) STORED
);
CREATE INDEX changes_search_idx ON changes USING gin (search);
CREATE INDEX changes_window_idx ON changes (planned_start, planned_end) WHERE status NOT IN ('rejected', 'cancelled');
CREATE INDEX changes_actual_idx ON changes (actual_start) WHERE actual_start IS NOT NULL;
CREATE INDEX changes_problem_idx ON changes (problem_id) WHERE problem_id IS NOT NULL;

CREATE TABLE change_cis (
  change_id int NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  ci_id     int NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  added_by  int REFERENCES users(id),
  PRIMARY KEY (change_id, ci_id)
);
CREATE INDEX change_cis_ci_idx ON change_cis (ci_id);

-- One vote per approver and change; the requester cannot vote on their own change.
CREATE TABLE change_votes (
  change_id  int NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  user_id    int NOT NULL REFERENCES users(id),
  decision   text NOT NULL CHECK (decision IN ('approve', 'reject')),
  comment    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (change_id, user_id)
);

CREATE TABLE change_activity (
  id         serial PRIMARY KEY,
  change_id  int NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  user_id    int REFERENCES users(id),
  kind       text NOT NULL CHECK (kind IN ('created', 'comment', 'status', 'update', 'link', 'vote')),
  body       text NOT NULL DEFAULT '',
  data       jsonb NOT NULL DEFAULT '{}',
  channel    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_activity_change_idx ON change_activity (change_id, created_at);

CREATE TABLE change_links (
  id         serial PRIMARY KEY,
  change_id  int NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('change', 'incident', 'pull_request', 'pipeline', 'document')),
  reference  text NOT NULL,
  system     text NOT NULL DEFAULT '',
  url        text NOT NULL DEFAULT '',
  note       text NOT NULL DEFAULT '',
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (change_id, kind, reference)
);

-- Periods in which normal and standard changes may not be scheduled (emergency changes may).
CREATE TABLE change_freezes (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  reason     text NOT NULL DEFAULT '',
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

INSERT INTO settings (key, value) VALUES ('change_policy', '{"approvals": {"low": 1, "medium": 1, "high": 2}, "related_hours": 24}')
ON CONFLICT (key) DO NOTHING;
