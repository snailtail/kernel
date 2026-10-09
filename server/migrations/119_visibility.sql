-- Visibility and restricted records (#53, ADR 0002), enforced by PostgreSQL row-level security: every query –
-- lists, search, counts, reports, exports, MCP – sees only the rows its viewer may see. Kernel connects as a role
-- without BYPASSRLS and sets kernel.viewer before each statement (db.ts):
--   'system'                                   background work: everything
--   'u:<id>:<role>:<team ids>:<scoped practices>:<flags>'   a person (flags: noai)
--   '' or unset                                fail closed: no restricted rows, team-scoped practices hidden
ALTER TABLE problems ADD COLUMN restricted boolean NOT NULL DEFAULT false;
ALTER TABLE problems ADD COLUMN restricted_teams int[] NOT NULL DEFAULT '{}';
ALTER TABLE incidents ADD COLUMN restricted boolean NOT NULL DEFAULT false;
ALTER TABLE incidents ADD COLUMN restricted_teams int[] NOT NULL DEFAULT '{}';
ALTER TABLE changes ADD COLUMN restricted boolean NOT NULL DEFAULT false;
ALTER TABLE changes ADD COLUMN restricted_teams int[] NOT NULL DEFAULT '{}';
CREATE INDEX problems_restricted_idx ON problems (id) WHERE restricted;
CREATE INDEX incidents_restricted_idx ON incidents (id) WHERE restricted;
CREATE INDEX changes_restricted_idx ON changes (id) WHERE restricted;

-- Administrators can open a restricted record for an hour with a reason ("break glass"); audited and announced.
CREATE TABLE visibility_breakglass (
  id          serial PRIMARY KEY,
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_type text NOT NULL CHECK (record_type IN ('problem', 'incident', 'change')),
  record_id   int NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX visibility_breakglass_idx ON visibility_breakglass (user_id, record_type, record_id, expires_at);

INSERT INTO settings (key, value) VALUES ('visibility', '{"team_scoped": {"incident": false, "problem": false, "change": false}, "restricted_categories": []}') ON CONFLICT (key) DO NOTHING;
UPDATE settings SET value = value || '{"restricted_records": false}' WHERE key = 'ai_data';

-- The rule. Unrestricted, unscoped rows return early; restricted rows need the assignee, the creator, an allowed team
-- or an active break-glass; team-scoped practices show non-managers their teams' work, unteamed work and their own.
CREATE FUNCTION kernel_can_see(kind text, is_restricted boolean, allowed_teams int[], row_team int, row_assignee int, row_creator int, row_id int)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  v text := coalesce(current_setting('kernel.viewer', true), '');
  uid int;
  role text;
  teams int[];
  scoped text[];
  flags text;
BEGIN
  IF v = 'system' THEN RETURN true; END IF;
  IF v NOT LIKE 'u:%' THEN
    RETURN NOT is_restricted;
  END IF;
  uid := split_part(v, ':', 2)::int;
  role := split_part(v, ':', 3);
  teams := coalesce(nullif(string_to_array(split_part(v, ':', 4), ','), '{}')::int[], '{}');
  scoped := string_to_array(split_part(v, ':', 5), ',');
  flags := split_part(v, ':', 6);
  IF is_restricted THEN
    IF flags LIKE '%noai%' THEN RETURN false; END IF;
    -- coalesce: a missing assignee or creator (NULL) must count as "no", never as unknown.
    IF NOT coalesce(row_assignee = uid OR row_creator = uid OR allowed_teams && teams
            OR (role = 'admin' AND EXISTS (SELECT 1 FROM visibility_breakglass b WHERE b.user_id = uid AND b.record_type = kind AND b.record_id = row_id AND b.expires_at > now())), false) THEN
      RETURN false;
    END IF;
  END IF;
  IF kind = ANY(scoped) AND role NOT IN ('admin', 'problem_manager') THEN
    RETURN coalesce(row_team IS NULL OR row_team = ANY(teams) OR row_assignee = uid OR row_creator = uid, false);
  END IF;
  RETURN true;
END $$;

ALTER TABLE problems ENABLE ROW LEVEL SECURITY;
ALTER TABLE problems FORCE ROW LEVEL SECURITY;
CREATE POLICY problems_visible ON problems USING (kernel_can_see('problem', restricted, restricted_teams, team_id, assignee_id, created_by, id));
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY incidents_visible ON incidents USING (kernel_can_see('incident', restricted, restricted_teams, team_id, assignee_id, created_by, id));
ALTER TABLE changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE changes FORCE ROW LEVEL SECURITY;
CREATE POLICY changes_visible ON changes USING (kernel_can_see('change', restricted, restricted_teams, team_id, assignee_id, created_by, id));

-- Child rows follow their record (RLS applies inside the EXISTS), so hidden records hide their history, links,
-- CIs and counts too, and nothing can be added to a record its viewer cannot see.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('problem_activity', 'problem_id', 'problems'), ('problem_links', 'problem_id', 'problems'), ('problem_cis', 'problem_id', 'problems'),
      ('problem_actions', 'problem_id', 'problems'), ('problem_analyses', 'problem_id', 'problems'), ('problem_watchers', 'problem_id', 'problems'),
      ('pending_approvals', 'problem_id', 'problems'),
      ('incident_activity', 'incident_id', 'incidents'), ('incident_links', 'incident_id', 'incidents'), ('incident_cis', 'incident_id', 'incidents'),
      ('incident_people', 'incident_id', 'incidents'), ('incident_articles', 'incident_id', 'incidents'), ('sla_events', 'incident_id', 'incidents'),
      ('change_activity', 'change_id', 'changes'), ('change_links', 'change_id', 'changes'), ('change_cis', 'change_id', 'changes'),
      ('change_votes', 'change_id', 'changes'), ('change_organisations', 'change_id', 'changes')
    ) AS x(tbl, col, parent)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('CREATE POLICY %I ON %I USING (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I))', t.tbl || '_visible', t.tbl, t.parent, t.col);
  END LOOP;
END $$;

-- Is a Kernel ref one the viewer must not learn about? (It exists, but the viewer cannot see it.) Runs as the owner
-- to know that the row exists, and applies the caller's viewer to decide.
CREATE FUNCTION kernel_ref_hidden(ref text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
BEGIN
  IF ref ~ '^PRB\d{6}$' THEN
    SELECT 'problem' AS k, restricted, restricted_teams, team_id, assignee_id, created_by, id INTO r FROM problems WHERE problems.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^INC\d{6}$' THEN
    SELECT 'incident' AS k, restricted, restricted_teams, team_id, assignee_id, created_by, id INTO r FROM incidents WHERE incidents.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^CHG\d{6}$' THEN
    SELECT 'change' AS k, restricted, restricted_teams, team_id, assignee_id, created_by, id INTO r FROM changes WHERE changes.ref = kernel_ref_hidden.ref;
  ELSE
    RETURN false;
  END IF;
  IF r IS NULL THEN RETURN false; END IF;
  RETURN NOT kernel_can_see(r.k, r.restricted, r.restricted_teams, r.team_id, r.assignee_id, r.created_by, r.id);
END $$;

-- Links to Kernel records the viewer cannot see are hidden (no ref, no title, not counted).
ALTER POLICY problem_links_visible ON problem_links USING (EXISTS (SELECT 1 FROM problems p WHERE p.id = problem_id) AND NOT (system IN ('', 'Kernel') AND kernel_ref_hidden(reference)));
ALTER POLICY incident_links_visible ON incident_links USING (EXISTS (SELECT 1 FROM incidents p WHERE p.id = incident_id) AND NOT (system IN ('', 'Kernel') AND kernel_ref_hidden(reference)));
ALTER POLICY change_links_visible ON change_links USING (EXISTS (SELECT 1 FROM changes p WHERE p.id = change_id) AND NOT (system IN ('', 'Kernel') AND kernel_ref_hidden(reference)));

-- Attachments follow their record; knowledge articles are never more visible than the problem they publish.
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY attachments_visible ON attachments USING (
  CASE record_type
    WHEN 'problem' THEN EXISTS (SELECT 1 FROM problems p WHERE p.ref = record_ref)
    WHEN 'incident' THEN EXISTS (SELECT 1 FROM incidents p WHERE p.ref = record_ref)
    WHEN 'change' THEN EXISTS (SELECT 1 FROM changes p WHERE p.ref = record_ref)
    ELSE true END);
ALTER TABLE attachment_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment_blobs FORCE ROW LEVEL SECURITY;
CREATE POLICY attachment_blobs_visible ON attachment_blobs USING (EXISTS (SELECT 1 FROM attachments a WHERE a.id = attachment_id));
ALTER TABLE articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE articles FORCE ROW LEVEL SECURITY;
CREATE POLICY articles_visible ON articles USING (problem_id IS NULL OR EXISTS (SELECT 1 FROM problems p WHERE p.id = problem_id));

-- Triggers that keep other tables in step act for the system, whoever's change fired them.
CREATE OR REPLACE FUNCTION kernel_team_renamed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev text := coalesce(current_setting('kernel.viewer', true), '');
BEGIN
  PERFORM set_config('kernel.viewer', 'system', true);
  UPDATE incidents SET assignment_group = NEW.name WHERE team_id = NEW.id AND assignment_group IS DISTINCT FROM NEW.name;
  UPDATE event_rules SET assignment_group = NEW.name WHERE team_id = NEW.id AND assignment_group IS DISTINCT FROM NEW.name;
  PERFORM set_config('kernel.viewer', prev, true);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION kernel_sync_known_error_articles() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev text := coalesce(current_setting('kernel.viewer', true), '');
  changed text := concat_ws(', ',
    CASE WHEN NEW.title IS DISTINCT FROM OLD.title THEN 'title' END,
    CASE WHEN NEW.description IS DISTINCT FROM OLD.description THEN 'symptoms' END,
    CASE WHEN NEW.root_cause IS DISTINCT FROM OLD.root_cause THEN 'cause' END,
    CASE WHEN NEW.workaround IS DISTINCT FROM OLD.workaround THEN 'workaround' END);
BEGIN
  PERFORM set_config('kernel.viewer', 'system', true);
  WITH synced AS (
    UPDATE articles SET title = NEW.title, body = kernel_known_error_article_body(NEW), updated_at = now()
     WHERE problem_id = NEW.id AND synced_with_problem AND status <> 'retired'
       AND (title IS DISTINCT FROM NEW.title OR body IS DISTINCT FROM kernel_known_error_article_body(NEW))
    RETURNING id
  )
  INSERT INTO article_activity (article_id, kind, body, data)
  SELECT id, 'update', 'Synced from ' || NEW.ref || ': ' || coalesce(nullif(changed, ''), 'text'), jsonb_build_object('problem', NEW.ref, 'fields', changed) FROM synced;
  IF NEW.status IN ('resolved', 'closed') AND OLD.status NOT IN ('resolved', 'closed') THEN
    WITH retired AS (
      UPDATE articles SET status = 'retired', retired_at = now(), updated_at = now()
       WHERE problem_id = NEW.id AND synced_with_problem AND status <> 'retired' RETURNING id
    )
    INSERT INTO article_activity (article_id, kind, body, data)
    SELECT id, 'status', 'Retired: ' || NEW.ref || ' is resolved', jsonb_build_object('to', 'retired', 'problem', NEW.ref) FROM retired;
  END IF;
  PERFORM set_config('kernel.viewer', prev, true);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION kernel_delete_attachments() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev text := coalesce(current_setting('kernel.viewer', true), '');
BEGIN
  PERFORM set_config('kernel.viewer', 'system', true);
  DELETE FROM attachments WHERE record_type = TG_ARGV[0] AND record_ref = OLD.ref;
  PERFORM set_config('kernel.viewer', prev, true);
  RETURN OLD;
END $$;

-- May this user see this record? For notifications, which go to people other than the one acting.
CREATE FUNCTION kernel_user_can_see(uid int, ref text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  prev text := coalesce(current_setting('kernel.viewer', true), '');
  viewer text;
  hidden boolean;
BEGIN
  SELECT 'u:' || u.id || ':' || u.role || ':' || coalesce((SELECT string_agg(team_id::text, ',') FROM team_members WHERE user_id = u.id), '') || '::'
    INTO viewer FROM users u WHERE u.id = uid AND u.active;
  IF viewer IS NULL THEN RETURN false; END IF;
  PERFORM set_config('kernel.viewer', viewer, true);
  hidden := kernel_ref_hidden(ref);
  PERFORM set_config('kernel.viewer', prev, true);
  RETURN NOT hidden;
END $$;

-- Break-glass needs the record's id although the administrator cannot see it (administrators only, checked in code).
CREATE FUNCTION kernel_record_lookup(ref text, OUT kind text, OUT id int, OUT is_restricted boolean, OUT assignee_id int, OUT created_by int, OUT team_id int, OUT allowed_teams int[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'problem', p.id, p.restricted, p.assignee_id, p.created_by, p.team_id, p.restricted_teams FROM problems p WHERE p.ref = $1
  UNION ALL SELECT 'incident', i.id, i.restricted, i.assignee_id, i.created_by, i.team_id, i.restricted_teams FROM incidents i WHERE i.ref = $1
  UNION ALL SELECT 'change', c.id, c.restricted, c.assignee_id, c.created_by, c.team_id, c.restricted_teams FROM changes c WHERE c.ref = $1
$$;

-- Do restricted records exist that the viewer cannot see? (Managers' numbers then say they are incomplete.)
CREATE FUNCTION kernel_hidden_records_exist() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM problems p WHERE p.restricted AND NOT kernel_can_see('problem', p.restricted, p.restricted_teams, p.team_id, p.assignee_id, p.created_by, p.id))
      OR EXISTS (SELECT 1 FROM incidents i WHERE i.restricted AND NOT kernel_can_see('incident', i.restricted, i.restricted_teams, i.team_id, i.assignee_id, i.created_by, i.id))
      OR EXISTS (SELECT 1 FROM changes c WHERE c.restricted AND NOT kernel_can_see('change', c.restricted, c.restricted_teams, c.team_id, c.assignee_id, c.created_by, c.id))
$$;
