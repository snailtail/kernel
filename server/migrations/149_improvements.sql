-- Continual improvement register (#52): a lightweight register of improvements (IMP000012) that come from reviews,
-- problems, service reviews or anyone's idea, rated by value and effort, approved by a manager and closed with the
-- benefit they brought. Not a project tool: the work itself happens in the changes, problems and actions it links.
CREATE SEQUENCE improvement_ref_seq;

CREATE TABLE improvements (
  id                     serial PRIMARY KEY,
  ref                    text NOT NULL UNIQUE DEFAULT 'IMP' || lpad(nextval('improvement_ref_seq')::text, 6, '0'),
  title                  text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 300),
  description            text NOT NULL DEFAULT '',
  source                 text NOT NULL DEFAULT 'idea' CHECK (source IN ('review', 'problem', 'service_review', 'idea')),
  -- The record it came from (PIR000003, PRB000012, a service ref), when there is one.
  source_ref             text,
  service_id             int REFERENCES configuration_items(id) ON DELETE SET NULL,
  owner_id               int REFERENCES users(id),
  value                  smallint CHECK (value BETWEEN 1 AND 5),
  effort                 smallint CHECK (effort BETWEEN 1 AND 5),
  status                 text NOT NULL DEFAULT 'idea' CHECK (status IN ('idea', 'approved', 'in_progress', 'done', 'rejected')),
  -- What it brought, in the owner's words; required to call it done.
  benefit                text NOT NULL DEFAULT '',
  reject_reason          text NOT NULL DEFAULT '',
  -- A dashboard tile (kpis.ts TILES) whose trend shows whether it worked.
  kpi                    text,
  restricted             boolean NOT NULL DEFAULT false,
  restricted_teams       int[] NOT NULL DEFAULT '{}',
  classification         text NOT NULL DEFAULT 'normal' CHECK (classification IN ('normal', 'confidential')),
  contains_personal_data boolean NOT NULL DEFAULT false,
  decided_by             int REFERENCES users(id),
  decided_at             timestamptz,
  done_at                timestamptz,
  created_by             int REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  search                 tsvector GENERATED ALWAYS AS (to_tsvector('simple', ref || ' ' || title || ' ' || description)) STORED,
  CHECK (status <> 'done' OR length(trim(benefit)) > 0)
);
CREATE INDEX improvements_status_idx ON improvements (status, updated_at DESC);
CREATE INDEX improvements_search_idx ON improvements USING gin (search);
CREATE INDEX improvements_restricted_idx ON improvements (id) WHERE restricted;

CREATE TABLE improvement_activity (
  id             serial PRIMARY KEY,
  improvement_id int NOT NULL REFERENCES improvements(id) ON DELETE CASCADE,
  user_id        int REFERENCES users(id),
  kind           text NOT NULL CHECK (kind IN ('created', 'comment', 'status', 'update', 'link')),
  body           text NOT NULL DEFAULT '',
  data           jsonb NOT NULL DEFAULT '{}',
  channel        text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX improvement_activity_idx ON improvement_activity (improvement_id, created_at DESC);

-- The changes, problems and actions that implement it (an action by its id), and other references.
CREATE TABLE improvement_links (
  id             serial PRIMARY KEY,
  improvement_id int NOT NULL REFERENCES improvements(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('change', 'problem', 'action', 'incident', 'review', 'document')),
  reference      text NOT NULL,
  system         text NOT NULL DEFAULT '',
  url            text NOT NULL DEFAULT '',
  note           text NOT NULL DEFAULT '',
  created_by     int REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (improvement_id, kind, reference)
);
CREATE INDEX improvement_links_reference_idx ON improvement_links (kind, reference);

-- A review's follow-up can become an improvement instead of an action (#109), linked the same way.
ALTER TABLE incident_review_items ADD COLUMN improvement_id int REFERENCES improvements(id) ON DELETE SET NULL;

-- Visibility (#53, ADR 0002) as for problems: an improvement made from a restricted record is restricted itself.
-- Improvements have no team, so team scoping never applies; the owner counts as the assignee.
ALTER TABLE improvements ENABLE ROW LEVEL SECURITY;
ALTER TABLE improvements FORCE ROW LEVEL SECURITY;
CREATE POLICY improvements_visible ON improvements USING (
  NOT restricted OR kernel_can_see('improvement', restricted, restricted_teams, NULL, owner_id, created_by, id));
ALTER TABLE improvement_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE improvement_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY improvement_activity_visible ON improvement_activity USING (EXISTS (SELECT 1 FROM improvements p WHERE p.id = improvement_id));
ALTER TABLE improvement_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE improvement_links FORCE ROW LEVEL SECURITY;
CREATE POLICY improvement_links_visible ON improvement_links USING (
  EXISTS (SELECT 1 FROM improvements p WHERE p.id = improvement_id) AND NOT (system IN ('', 'Kernel') AND kernel_ref_hidden(reference)));

ALTER TABLE visibility_breakglass DROP CONSTRAINT visibility_breakglass_record_type_check;
ALTER TABLE visibility_breakglass ADD CONSTRAINT visibility_breakglass_record_type_check CHECK (record_type IN ('problem', 'incident', 'change', 'improvement'));
ALTER TABLE record_reveals DROP CONSTRAINT record_reveals_record_type_check;
ALTER TABLE record_reveals ADD CONSTRAINT record_reveals_record_type_check CHECK (record_type IN ('problem', 'incident', 'change', 'improvement'));

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
$$;

CREATE OR REPLACE FUNCTION kernel_hidden_records_exist() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM problems p WHERE p.restricted AND NOT kernel_can_see('problem', p.restricted, p.restricted_teams, p.team_id, p.assignee_id, p.created_by, p.id))
      OR EXISTS (SELECT 1 FROM incidents i WHERE i.restricted AND NOT kernel_can_see('incident', i.restricted, i.restricted_teams, i.team_id, i.assignee_id, i.created_by, i.id))
      OR EXISTS (SELECT 1 FROM changes c WHERE c.restricted AND NOT kernel_can_see('change', c.restricted, c.restricted_teams, c.team_id, c.assignee_id, c.created_by, c.id))
      OR EXISTS (SELECT 1 FROM improvements m WHERE m.restricted AND NOT kernel_can_see('improvement', m.restricted, m.restricted_teams, NULL, m.owner_id, m.created_by, m.id))
$$;

-- Saved views (#110) for the improvement list.
ALTER TABLE list_views DROP CONSTRAINT list_views_list_check;
ALTER TABLE list_views ADD CONSTRAINT list_views_list_check CHECK (list IN ('problems', 'actions', 'incidents', 'changes', 'alerts', 'known_errors', 'knowledge', 'cis', 'candidates', 'improvements'));

-- Live updates (#70).
CREATE TRIGGER improvements_live AFTER INSERT OR UPDATE OR DELETE ON improvements FOR EACH ROW EXECUTE FUNCTION kernel_live_notify('improvement', 'id');
CREATE TRIGGER improvement_activity_live AFTER INSERT OR UPDATE OR DELETE ON improvement_activity FOR EACH ROW EXECUTE FUNCTION kernel_live_notify('improvement', 'improvement_id');
CREATE TRIGGER improvement_links_live AFTER INSERT OR UPDATE OR DELETE ON improvement_links FOR EACH ROW EXECUTE FUNCTION kernel_live_notify('improvement', 'improvement_id');
