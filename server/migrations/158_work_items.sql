-- Development work (#165, epic #164): epics, stories, bugs and tasks in one register (WI000012), ordered per team in a
-- backlog. One kind with a type rather than a prefix per type: an item's ref never changes when triage turns a story
-- into a bug, and visibility, masking, redaction and live updates have one table to know. The `development` module is
-- off by default (modules.ts).
CREATE SEQUENCE work_item_ref_seq;

CREATE TABLE work_items (
  id                     serial PRIMARY KEY,
  ref                    text NOT NULL UNIQUE DEFAULT 'WI' || lpad(nextval('work_item_ref_seq')::text, 6, '0'),
  type                   text NOT NULL CHECK (type IN ('epic', 'story', 'bug', 'task')),
  title                  text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 300),
  description            text NOT NULL DEFAULT '',
  status                 text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'ready', 'in_progress', 'in_review', 'done', 'removed')),
  -- The place in the team's backlog: a new item goes last, a drag takes a value between its neighbours
  -- (development/work-items.ts), so moving one item rewrites one row.
  rank                   double precision NOT NULL,
  points                 smallint CHECK (points IN (1, 2, 3, 5, 8, 13)),
  team_id                int REFERENCES teams(id) ON DELETE SET NULL,
  assignee_id            int REFERENCES users(id),
  -- epic → story or bug → task; the service checks the types, which also keeps it to three levels without cycles.
  parent_id              int REFERENCES work_items(id) ON DELETE SET NULL CHECK (parent_id <> id),
  -- [{ "criterion": "…", "done": false }]
  acceptance_criteria    jsonb NOT NULL DEFAULT '[]',
  labels                 text[] NOT NULL DEFAULT '{}',
  -- A bug's report.
  found_in               text NOT NULL DEFAULT '',  -- where it happens: version, browser, environment
  steps_to_reproduce     text NOT NULL DEFAULT '',
  expected_result        text NOT NULL DEFAULT '',
  actual_result          text NOT NULL DEFAULT '',
  remove_reason          text NOT NULL DEFAULT '',
  restricted             boolean NOT NULL DEFAULT false,
  restricted_teams       int[] NOT NULL DEFAULT '{}',
  classification         text NOT NULL DEFAULT 'normal' CHECK (classification IN ('normal', 'confidential')),
  contains_personal_data boolean NOT NULL DEFAULT false,
  started_at             timestamptz,
  done_at                timestamptz,
  created_by             int REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  search                 tsvector GENERATED ALWAYS AS (to_tsvector('simple', ref || ' ' || title || ' ' || description)) STORED,
  CHECK (jsonb_typeof(acceptance_criteria) = 'array')
);
-- One place per rank in each backlog (items without a team share one).
CREATE UNIQUE INDEX work_items_rank_idx ON work_items (coalesce(team_id, 0), rank);
CREATE INDEX work_items_status_idx ON work_items (status, updated_at DESC);
CREATE INDEX work_items_parent_idx ON work_items (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX work_items_labels_idx ON work_items USING gin (labels);
CREATE INDEX work_items_search_idx ON work_items USING gin (search);
CREATE INDEX work_items_restricted_idx ON work_items (id) WHERE restricted;

CREATE TABLE work_item_activity (
  id           serial PRIMARY KEY,
  work_item_id int NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  user_id      int REFERENCES users(id),
  kind         text NOT NULL CHECK (kind IN ('created', 'comment', 'status', 'update', 'link', 'backlog')),
  body         text NOT NULL DEFAULT '',
  data         jsonb NOT NULL DEFAULT '{}',
  channel      text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_item_activity_idx ON work_item_activity (work_item_id, created_at DESC);

-- Related work items and documents; the links to problems, incidents, changes and improvements come with #167.
CREATE TABLE work_item_links (
  id           serial PRIMARY KEY,
  work_item_id int NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('work_item', 'document')),
  reference    text NOT NULL,
  system       text NOT NULL DEFAULT '',
  url          text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  created_by   int REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_item_id, kind, reference)
);
CREATE INDEX work_item_links_reference_idx ON work_item_links (kind, reference);

-- A team's Definition of Ready and Definition of Done: shown when an item moves to ready or done. Guidance, not a
-- gate: what was not confirmed is logged on the item.
CREATE TABLE work_definitions (
  team_id    int PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  ready      text[] NOT NULL DEFAULT '{}',
  done       text[] NOT NULL DEFAULT '{}',
  updated_by int REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Visibility (#53, ADR 0002) as for problems: restricted to its people and teams, and team-scoped when switched on.
ALTER TABLE work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_items FORCE ROW LEVEL SECURITY;
CREATE POLICY work_items_visible ON work_items USING (CASE
  WHEN restricted THEN kernel_can_see('work_item', restricted, restricted_teams, team_id, assignee_id, created_by, id)
  WHEN NOT kernel_scoped('work_item') THEN true
  ELSE team_id IS NULL OR team_id = ANY(kernel_teams()) OR assignee_id = kernel_uid() OR created_by = kernel_uid() END);
ALTER TABLE work_item_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY work_item_activity_visible ON work_item_activity USING (EXISTS (SELECT 1 FROM work_items w WHERE w.id = work_item_id));
ALTER TABLE work_item_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_links FORCE ROW LEVEL SECURITY;
CREATE POLICY work_item_links_visible ON work_item_links USING (
  EXISTS (SELECT 1 FROM work_items w WHERE w.id = work_item_id) AND NOT (system IN ('', 'Kernel') AND kernel_ref_hidden(reference)));

ALTER TABLE visibility_breakglass DROP CONSTRAINT visibility_breakglass_record_type_check;
ALTER TABLE visibility_breakglass ADD CONSTRAINT visibility_breakglass_record_type_check CHECK (record_type IN ('problem', 'incident', 'change', 'improvement', 'request', 'work_item'));
ALTER TABLE record_reveals DROP CONSTRAINT record_reveals_record_type_check;
ALTER TABLE record_reveals ADD CONSTRAINT record_reveals_record_type_check CHECK (record_type IN ('problem', 'incident', 'change', 'improvement', 'request', 'work_item'));

CREATE OR REPLACE FUNCTION kernel_ref_hidden(ref text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
BEGIN
  IF ref ~ '^PRB\d{6}$' THEN
    SELECT 'problem' AS k, restricted, restricted_teams, team_id, assignee_id, created_by, id INTO r FROM problems WHERE problems.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^INC\d{6}$' THEN
    SELECT 'incident' AS k, restricted, restricted_teams, team_id, assignee_id, created_by, id INTO r FROM incidents WHERE incidents.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^CHG\d{6}$' THEN
    SELECT 'change' AS k, restricted, restricted_teams, team_id, assignee_id, created_by, id INTO r FROM changes WHERE changes.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^PIR\d{6}$' THEN
    SELECT 'incident' AS k, i.restricted, i.restricted_teams, i.team_id, i.assignee_id, i.created_by, i.id INTO r
      FROM incident_reviews x JOIN incidents i ON i.id = x.incident_id WHERE x.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^IMP\d{6}$' THEN
    SELECT 'improvement' AS k, restricted, restricted_teams, NULL::int AS team_id, owner_id AS assignee_id, created_by, id INTO r FROM improvements WHERE improvements.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^REQ\d{6}$' THEN
    SELECT 'request' AS k, restricted, restricted_teams, NULL::int AS team_id, NULL::int AS assignee_id, created_by, id INTO r FROM requests WHERE requests.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^WI\d{6}$' THEN
    SELECT 'work_item' AS k, restricted, restricted_teams, team_id, assignee_id, created_by, id INTO r FROM work_items WHERE work_items.ref = kernel_ref_hidden.ref;
  ELSE
    RETURN false;
  END IF;
  IF r IS NULL THEN RETURN false; END IF;
  RETURN NOT kernel_can_see(r.k, r.restricted, r.restricted_teams, r.team_id, r.assignee_id, r.created_by, r.id);
END $$;

CREATE OR REPLACE FUNCTION kernel_record_lookup(ref text, OUT kind text, OUT id int, OUT is_restricted boolean, OUT assignee_id int, OUT created_by int, OUT team_id int, OUT allowed_teams int[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'problem', p.id, p.restricted, p.assignee_id, p.created_by, p.team_id, p.restricted_teams FROM problems p WHERE p.ref = $1
  UNION ALL SELECT 'incident', i.id, i.restricted, i.assignee_id, i.created_by, i.team_id, i.restricted_teams FROM incidents i WHERE i.ref = $1
  UNION ALL SELECT 'change', c.id, c.restricted, c.assignee_id, c.created_by, c.team_id, c.restricted_teams FROM changes c WHERE c.ref = $1
  UNION ALL SELECT 'improvement', m.id, m.restricted, m.owner_id, m.created_by, NULL::int, m.restricted_teams FROM improvements m WHERE m.ref = $1
  UNION ALL SELECT 'request', q.id, q.restricted, NULL::int, q.created_by, NULL::int, q.restricted_teams FROM requests q WHERE q.ref = $1
  UNION ALL SELECT 'work_item', w.id, w.restricted, w.assignee_id, w.created_by, w.team_id, w.restricted_teams FROM work_items w WHERE w.ref = $1
$$;

CREATE OR REPLACE FUNCTION kernel_hidden_records_exist() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM problems p WHERE p.restricted AND NOT kernel_can_see('problem', p.restricted, p.restricted_teams, p.team_id, p.assignee_id, p.created_by, p.id))
      OR EXISTS (SELECT 1 FROM incidents i WHERE i.restricted AND NOT kernel_can_see('incident', i.restricted, i.restricted_teams, i.team_id, i.assignee_id, i.created_by, i.id))
      OR EXISTS (SELECT 1 FROM changes c WHERE c.restricted AND NOT kernel_can_see('change', c.restricted, c.restricted_teams, c.team_id, c.assignee_id, c.created_by, c.id))
      OR EXISTS (SELECT 1 FROM improvements m WHERE m.restricted AND NOT kernel_can_see('improvement', m.restricted, m.restricted_teams, NULL, m.owner_id, m.created_by, m.id))
      OR EXISTS (SELECT 1 FROM requests q WHERE q.restricted AND NOT kernel_can_see('request', q.restricted, q.restricted_teams, NULL, NULL, q.created_by, q.id))
      OR EXISTS (SELECT 1 FROM work_items w WHERE w.restricted AND NOT kernel_can_see('work_item', w.restricted, w.restricted_teams, w.team_id, w.assignee_id, w.created_by, w.id))
$$;

-- Saved views (#110) for the backlog.
ALTER TABLE list_views DROP CONSTRAINT list_views_list_check;
ALTER TABLE list_views ADD CONSTRAINT list_views_list_check CHECK (list IN ('problems', 'actions', 'incidents', 'changes', 'alerts', 'known_errors', 'knowledge', 'cis', 'candidates', 'improvements', 'requests', 'work_items'));

-- Live updates (#70).
CREATE TRIGGER work_items_live AFTER INSERT OR UPDATE OR DELETE ON work_items FOR EACH ROW EXECUTE FUNCTION kernel_live_notify('work_item', 'id');
CREATE TRIGGER work_item_activity_live AFTER INSERT OR UPDATE OR DELETE ON work_item_activity FOR EACH ROW EXECUTE FUNCTION kernel_live_notify('work_item', 'work_item_id');
CREATE TRIGGER work_item_links_live AFTER INSERT OR UPDATE OR DELETE ON work_item_links FOR EACH ROW EXECUTE FUNCTION kernel_live_notify('work_item', 'work_item_id');
