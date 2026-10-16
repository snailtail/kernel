-- Security events (#64, A09): sign-ins and their failures, denials, token use from new addresses, admin and
-- credential changes, data access (exports, reveals), CSP reports, rate-limit hits, invalid webhook signatures and
-- blocked outbound requests. Kept apart from the application log and the audit trail, for a limited time
-- (settings.privacy.security_event_days). The application may add and read, and delete only by retention.
CREATE TABLE security_events (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  action       text NOT NULL,
  category     text NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied', 'blocked', 'info')),
  severity     text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'minor', 'major', 'critical')),
  user_id      int REFERENCES users(id),
  -- A sign-in name that matches no account is stored as a keyed digest (ADR 0001), never as typed.
  account      text NOT NULL DEFAULT '',
  actor_type   text NOT NULL DEFAULT '',
  channel      text NOT NULL DEFAULT '',
  token_prefix text NOT NULL DEFAULT '',
  ip           text,
  country      text NOT NULL DEFAULT '',
  user_agent   text NOT NULL DEFAULT '',
  request_id   text NOT NULL DEFAULT '',
  target       text NOT NULL DEFAULT '',
  detail       jsonb NOT NULL DEFAULT '{}',
  message      text NOT NULL DEFAULT ''
);
CREATE INDEX security_events_at_idx ON security_events (at);
CREATE INDEX security_events_action_idx ON security_events (action, at);
CREATE INDEX security_events_user_idx ON security_events (user_id, at) WHERE user_id IS NOT NULL;
CREATE INDEX security_events_ip_idx ON security_events (ip, at) WHERE ip IS NOT NULL;

-- The addresses each API token has been used from, so the first use from a new one stands out.
CREATE TABLE api_token_ips (
  token_id   int NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
  ip         text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, ip)
);

UPDATE settings SET value = value || '{"security_event_days": 365}' WHERE key = 'privacy' AND NOT value ? 'security_event_days';
