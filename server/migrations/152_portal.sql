-- The self-service portal (#45), part 1. A portal identity is a person (people), never a Kernel user: its session has
-- its own table and cookie and can never authorise anything under /api/* outside /api/portal/*.

-- Portal sessions: hash only, eight hours from sign-in, bound to the person.
CREATE TABLE portal_sessions (
  token_hash   text PRIMARY KEY,
  person_id    int NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  method       text NOT NULL CHECK (method IN ('link', 'sso')),
  ip           text NOT NULL DEFAULT '',
  user_agent   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX portal_sessions_person_idx ON portal_sessions (person_id);
CREATE INDEX portal_sessions_expires_idx ON portal_sessions (expires_at);

-- Sign-in links by mail: 256 random bits, of which only the SHA-256 is kept; 15 minutes, single use. The token is
-- minted when the mail is sent, so the outbox never holds it.
CREATE TABLE portal_links (
  id         bigserial PRIMARY KEY,
  person_id  int NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX portal_links_person_idx ON portal_links (person_id);

-- Mail to people through the portal: sign-in links, and replies to the requester on an incident or request.
CREATE TABLE portal_mail (
  id              bigserial PRIMARY KEY,
  person_id       int REFERENCES people(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('signin', 'reply')),
  incident_id     int REFERENCES incidents(id) ON DELETE CASCADE,
  request_id      int REFERENCES requests(id) ON DELETE CASCADE,
  -- The reply (incident_activity or request_activity) the mail carries.
  activity_id     int,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  sent_at         timestamptz,
  error           text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'signin' OR (incident_id IS NULL) <> (request_id IS NULL))
);
CREATE INDEX portal_mail_due_idx ON portal_mail (next_attempt_at) WHERE status IN ('pending', 'sending');
-- A reply mail names its record, so it is visible only with the record (sign-in mail has none and is the system's).
ALTER TABLE portal_mail ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_mail FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_mail_visible ON portal_mail USING (
  (incident_id IS NULL OR EXISTS (SELECT 1 FROM incidents i WHERE i.id = incident_id))
  AND (request_id IS NULL OR EXISTS (SELECT 1 FROM requests r WHERE r.id = request_id))
  AND (kind <> 'signin' OR current_setting('kernel.viewer', true) = 'system')
);

-- SSO serves the portal too: the same redirect URL, and the request says which sign-in it was.
ALTER TABLE sso_requests ADD COLUMN purpose text NOT NULL DEFAULT 'kernel' CHECK (purpose IN ('kernel', 'portal'));

-- Incidents reported in the portal, and the portal as an actor in the audit trail.
ALTER TABLE incidents DROP CONSTRAINT incidents_source_check;
ALTER TABLE incidents ADD CONSTRAINT incidents_source_check CHECK (source IN ('user', 'event', 'api', 'mcp', 'email', 'portal'));
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('user', 'api_token', 'mcp', 'integration', 'system', 'anonymous', 'portal'));
