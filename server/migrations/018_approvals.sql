-- Decisions requested through MCP wait for a person to approve them in the web UI (#76: an agent could otherwise
-- fabricate the human's confirmation, e.g. after a prompt injection).
CREATE TABLE pending_approvals (
  id                 serial PRIMARY KEY,
  problem_id         int NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('close', 'risk_decision', 'mark_duplicate')),
  payload            jsonb NOT NULL,
  summary            text NOT NULL,
  requested_by       int NOT NULL REFERENCES users(id),
  requested_via      text NOT NULL DEFAULT 'mcp',
  human_confirmation text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'failed')),
  decided_by         int REFERENCES users(id),
  decided_at         timestamptz,
  result             text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_approvals_open_idx ON pending_approvals (problem_id) WHERE status = 'pending';
INSERT INTO settings (key, value) VALUES ('mcp_decisions_require_approval', 'true') ON CONFLICT DO NOTHING;
