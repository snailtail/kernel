-- Personal data out of the audit trail (#57/#53). From now on audit_log stores the actor's id, not their name, and
-- personal values and free text as digests; the full texts live in the mutable record histories, which retention
-- and anonymisation can process. IP address and user agent move to audit_context, kept for a limited time.
-- Existing entries are unchanged (the chain stays verifiable); a one-time rewrite is an explicit, separate step.
CREATE TABLE audit_context (
  audit_id   bigint PRIMARY KEY REFERENCES audit_log(id),
  ip         text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_context_created_idx ON audit_context (created_at);
ALTER TABLE users ADD COLUMN erased_at timestamptz;
INSERT INTO settings (key, value) VALUES ('privacy', '{"audit_context_days": 365}') ON CONFLICT (key) DO NOTHING;
