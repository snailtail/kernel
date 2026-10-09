-- Content written through MCP is a proposal until a human confirms it (#76).
ALTER TABLE problems ADD COLUMN mcp_proposed text[] NOT NULL DEFAULT '{}';
ALTER TABLE problem_analyses ADD COLUMN proposed_via_mcp boolean NOT NULL DEFAULT false;
ALTER TABLE problem_analyses ADD COLUMN confirmed_by int REFERENCES users(id);
ALTER TABLE problem_analyses ADD COLUMN confirmed_at timestamptz;
-- The channel (web, api, mcp, system) each activity entry came through.
ALTER TABLE problem_activity ADD COLUMN channel text NOT NULL DEFAULT '';
