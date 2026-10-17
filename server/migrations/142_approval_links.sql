-- Approve or reject from email and chat (#48). Each approval_needed email or chat message carries a link with an
-- action token: 256 random bits, of which only the SHA-256 is stored. A link is bound to one approver, one approval
-- (a change waiting for authorisation, or an MCP request) and the version of the record when it was sent. It is
-- single-use and expires; GET only shows the decision, POST makes it.
ALTER TABLE notifications ADD COLUMN approval_id int REFERENCES pending_approvals(id) ON DELETE SET NULL;

CREATE TABLE approval_links (
  id          bigserial PRIMARY KEY,
  token_hash  bytea NOT NULL UNIQUE,
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  change_id   int REFERENCES changes(id) ON DELETE CASCADE,
  approval_id int REFERENCES pending_approvals(id) ON DELETE CASCADE,
  -- A fingerprint of what the approver is asked to decide on; a link stops working when it changes.
  version     text NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('email', 'chat')),
  delivery_id bigint REFERENCES notification_deliveries(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((change_id IS NULL) <> (approval_id IS NULL))
);
CREATE INDEX approval_links_change_idx ON approval_links (change_id) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX approval_links_delivery_idx ON approval_links (delivery_id);

-- A link belongs to its record: hidden with it, like the record's other rows (119_visibility.sql).
ALTER TABLE approval_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_links FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_links_visible ON approval_links USING (
  (change_id IS NULL OR EXISTS (SELECT 1 FROM changes c WHERE c.id = change_id))
  AND (approval_id IS NULL OR EXISTS (SELECT 1 FROM pending_approvals a WHERE a.id = approval_id))
);
