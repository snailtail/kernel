-- Service request management (#44), an optional module: "new account", "access to a system", "install software" are
-- not incidents. A catalogue of request items per service, each with a short form, an optional approval, an ordered
-- list of fulfilment tasks for teams and an SLA. A request (REQ000012) is made for a person (the requester) by the
-- user who logs it, answers the item's form, may wait for approval, and is fulfilled when its last task is done.

CREATE TABLE request_items (
  id                serial PRIMARY KEY,
  service_id        int NOT NULL REFERENCES configuration_items(id),
  name              text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  description       text NOT NULL DEFAULT '',
  -- At most 10 fields: { key, label, type: text|textarea|choice|person|ci|date, required, choices } (validated in requests.ts).
  form              jsonb NOT NULL DEFAULT '[]',
  -- Who approves: no one, the requester's manager (people.manager_id), the service owner, or any lead or member of a team.
  approval          text NOT NULL DEFAULT 'none' CHECK (approval IN ('none', 'requester_manager', 'service_owner', 'team')),
  approval_team_id  int REFERENCES teams(id),
  -- An ordered list of { title, team_id }.
  fulfilment_tasks  jsonb NOT NULL DEFAULT '[]',
  sla_id            int REFERENCES slas(id) ON DELETE SET NULL,
  -- Part 2 of #44: a standard change made from this template when the request is approved.
  standard_change_template_id int REFERENCES change_templates(id) ON DELETE SET NULL,
  active            boolean NOT NULL DEFAULT true,
  created_by        int REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((approval = 'team') = (approval_team_id IS NOT NULL)),
  UNIQUE (service_id, name)
);

CREATE SEQUENCE request_ref_seq;

CREATE TABLE requests (
  id                     serial PRIMARY KEY,
  ref                    text NOT NULL UNIQUE DEFAULT 'REQ' || lpad(nextval('request_ref_seq')::text, 6, '0'),
  item_id                int NOT NULL REFERENCES request_items(id),
  title                  text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 300),
  -- The person it is for; created_by is the user who logged it ("on behalf of").
  requester_id           int NOT NULL REFERENCES people(id),
  -- The item's form answered, by field key; checked against the form on the server.
  answers                jsonb NOT NULL DEFAULT '{}',
  status                 text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'awaiting_approval', 'in_fulfilment', 'fulfilled', 'rejected', 'cancelled')),
  priority               smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  -- The approvers resolved at submission (users); a requester never approves their own request.
  approval               text NOT NULL DEFAULT 'none',
  approver_ids           int[] NOT NULL DEFAULT '{}',
  decided_by             int REFERENCES users(id),
  decided_at             timestamptz,
  reject_reason          text NOT NULL DEFAULT '',
  cancel_reason          text NOT NULL DEFAULT '',
  -- The SLA clock (#43, sla.ts): from submission to fulfilled, paused while awaiting approval. resolved_at is when it
  -- was fulfilled, rejected or cancelled; responded_at when someone first acted on it.
  sla_id                 int REFERENCES slas(id) ON DELETE SET NULL,
  response_due_at        timestamptz,
  resolution_due_at      timestamptz,
  responded_at           timestamptz,
  resolved_at            timestamptz,
  sla_paused_since       timestamptz,
  sla_paused_minutes     int NOT NULL DEFAULT 0,
  response_breached_at   timestamptz,
  resolution_breached_at timestamptz,
  restricted             boolean NOT NULL DEFAULT false,
  restricted_teams       int[] NOT NULL DEFAULT '{}',
  classification         text NOT NULL DEFAULT 'normal' CHECK (classification IN ('normal', 'confidential')),
  contains_personal_data boolean NOT NULL DEFAULT false,
  created_by             int REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  search                 tsvector GENERATED ALWAYS AS (to_tsvector('simple', ref || ' ' || title) || jsonb_to_tsvector('simple', answers, '["string"]')) STORED,
  CHECK (status <> 'rejected' OR length(trim(reject_reason)) > 0)
);
CREATE INDEX requests_status_idx ON requests (status, updated_at DESC);
CREATE INDEX requests_requester_idx ON requests (requester_id);
CREATE INDEX requests_search_idx ON requests USING gin (search);
CREATE INDEX requests_approvers_idx ON requests USING gin (approver_ids) WHERE status = 'awaiting_approval';

-- Fulfilment, in order: only the first pending task is open; the next opens when the one before is done.
CREATE TABLE request_tasks (
  id          serial PRIMARY KEY,
  request_id  int NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  position    smallint NOT NULL,
  title       text NOT NULL,
  team_id     int REFERENCES teams(id) ON DELETE SET NULL,
  assignee_id int REFERENCES users(id),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'open', 'done', 'cancelled')),
  note        text NOT NULL DEFAULT '',
  opened_at   timestamptz,
  done_by     int REFERENCES users(id),
  done_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, position)
);
CREATE INDEX request_tasks_queue_idx ON request_tasks (team_id) WHERE status = 'open';
CREATE INDEX request_tasks_assignee_idx ON request_tasks (assignee_id) WHERE status = 'open';

CREATE TABLE request_activity (
  id         serial PRIMARY KEY,
  request_id int NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  user_id    int REFERENCES users(id),
  kind       text NOT NULL CHECK (kind IN ('created', 'comment', 'status', 'update', 'link', 'task', 'approval', 'sla')),
  body       text NOT NULL DEFAULT '',
  data       jsonb NOT NULL DEFAULT '{}',
  channel    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX request_activity_idx ON request_activity (request_id, created_at DESC);

CREATE TABLE request_links (
  id         serial PRIMARY KEY,
  request_id int NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('incident', 'change', 'problem', 'ci', 'document')),
  reference  text NOT NULL,
  system     text NOT NULL DEFAULT '',
  url        text NOT NULL DEFAULT '',
  note       text NOT NULL DEFAULT '',
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, kind, reference)
);

-- Each warning (75 %) and breach fires once per request and target, as for incidents.
CREATE TABLE request_sla_events (
  request_id int NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  target     text NOT NULL CHECK (target IN ('response', 'resolution')),
  kind       text NOT NULL CHECK (kind IN ('warning', 'breach')),
  fired_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, target, kind)
);

-- Visibility (#53, ADR 0002) as for improvements: no team of its own; the creator (who logged it) is on the record.
ALTER TABLE requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE requests FORCE ROW LEVEL SECURITY;
CREATE POLICY requests_visible ON requests USING (
  NOT restricted OR kernel_can_see('request', restricted, restricted_teams, NULL, NULL, created_by, id));
ALTER TABLE request_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY request_tasks_visible ON request_tasks USING (EXISTS (SELECT 1 FROM requests r WHERE r.id = request_id));
ALTER TABLE request_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY request_activity_visible ON request_activity USING (EXISTS (SELECT 1 FROM requests r WHERE r.id = request_id));
ALTER TABLE request_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_links FORCE ROW LEVEL SECURITY;
CREATE POLICY request_links_visible ON request_links USING (
  EXISTS (SELECT 1 FROM requests r WHERE r.id = request_id) AND NOT (system IN ('', 'Kernel') AND kernel_ref_hidden(reference)));
ALTER TABLE request_sla_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_sla_events FORCE ROW LEVEL SECURITY;
CREATE POLICY request_sla_events_visible ON request_sla_events USING (EXISTS (SELECT 1 FROM requests r WHERE r.id = request_id));

ALTER TABLE visibility_breakglass DROP CONSTRAINT visibility_breakglass_record_type_check;
ALTER TABLE visibility_breakglass ADD CONSTRAINT visibility_breakglass_record_type_check CHECK (record_type IN ('problem', 'incident', 'change', 'improvement', 'request'));
ALTER TABLE record_reveals DROP CONSTRAINT record_reveals_record_type_check;
ALTER TABLE record_reveals ADD CONSTRAINT record_reveals_record_type_check CHECK (record_type IN ('problem', 'incident', 'change', 'improvement', 'request'));

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
$$;

CREATE OR REPLACE FUNCTION kernel_hidden_records_exist() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM problems p WHERE p.restricted AND NOT kernel_can_see('problem', p.restricted, p.restricted_teams, p.team_id, p.assignee_id, p.created_by, p.id))
      OR EXISTS (SELECT 1 FROM incidents i WHERE i.restricted AND NOT kernel_can_see('incident', i.restricted, i.restricted_teams, i.team_id, i.assignee_id, i.created_by, i.id))
      OR EXISTS (SELECT 1 FROM changes c WHERE c.restricted AND NOT kernel_can_see('change', c.restricted, c.restricted_teams, c.team_id, c.assignee_id, c.created_by, c.id))
      OR EXISTS (SELECT 1 FROM improvements m WHERE m.restricted AND NOT kernel_can_see('improvement', m.restricted, m.restricted_teams, NULL, m.owner_id, m.created_by, m.id))
      OR EXISTS (SELECT 1 FROM requests q WHERE q.restricted AND NOT kernel_can_see('request', q.restricted, q.restricted_teams, NULL, NULL, q.created_by, q.id))
$$;

-- Approval by link (#48): a request waiting for its approver is the third kind of link target.
ALTER TABLE approval_links ADD COLUMN request_id int REFERENCES requests(id) ON DELETE CASCADE;
ALTER TABLE approval_links DROP CONSTRAINT approval_links_check;
ALTER TABLE approval_links ADD CONSTRAINT approval_links_target_check CHECK (num_nonnulls(change_id, approval_id, request_id) = 1);
DROP POLICY approval_links_visible ON approval_links;
CREATE POLICY approval_links_visible ON approval_links USING (
  (change_id IS NULL OR EXISTS (SELECT 1 FROM changes c WHERE c.id = change_id))
  AND (approval_id IS NULL OR EXISTS (SELECT 1 FROM pending_approvals a WHERE a.id = approval_id))
  AND (request_id IS NULL OR EXISTS (SELECT 1 FROM requests r WHERE r.id = request_id))
);

-- Saved views (#110) for the request list.
ALTER TABLE list_views DROP CONSTRAINT list_views_list_check;
ALTER TABLE list_views ADD CONSTRAINT list_views_list_check CHECK (list IN ('problems', 'actions', 'incidents', 'changes', 'alerts', 'known_errors', 'knowledge', 'cis', 'candidates', 'improvements', 'requests'));

-- Live updates (#70).
CREATE TRIGGER requests_live AFTER INSERT OR UPDATE OR DELETE ON requests FOR EACH ROW EXECUTE FUNCTION kernel_live_notify('request', 'id');
CREATE TRIGGER request_activity_live AFTER INSERT OR UPDATE OR DELETE ON request_activity FOR EACH ROW EXECUTE FUNCTION kernel_live_notify('request', 'request_id');
CREATE TRIGGER request_tasks_live AFTER INSERT OR UPDATE OR DELETE ON request_tasks FOR EACH ROW EXECUTE FUNCTION kernel_live_notify('request', 'request_id');
CREATE TRIGGER request_links_live AFTER INSERT OR UPDATE OR DELETE ON request_links FOR EACH ROW EXECUTE FUNCTION kernel_live_notify('request', 'request_id');
