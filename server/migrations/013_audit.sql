-- Unified, append-only audit trail with a hash chain: who did what, when, how and why.
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_user_id int,
  actor_name    text NOT NULL DEFAULT '',
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'api_token', 'mcp', 'integration', 'system', 'anonymous')),
  channel       text NOT NULL DEFAULT '',
  token_prefix  text NOT NULL DEFAULT '',
  ip            text NOT NULL DEFAULT '',
  user_agent    text NOT NULL DEFAULT '',
  request_id    text NOT NULL DEFAULT '',
  entity_type   text NOT NULL,
  entity_ref    text NOT NULL DEFAULT '',
  action        text NOT NULL,
  changes       jsonb NOT NULL DEFAULT '{}',
  reason        text NOT NULL DEFAULT '',
  prev_hash     text NOT NULL,
  hash          text NOT NULL
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_ref, id DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, id DESC);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

-- Append-only: rows can never be changed or removed through SQL.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

ALTER TABLE api_tokens ADD COLUMN revoked_at timestamptz;
