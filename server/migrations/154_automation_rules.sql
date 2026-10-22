-- Automation rules (#49), part 1: when / if / then on incidents, problems, changes and requests. Declarative only:
-- the trigger, conditions and actions are JSON checked against allowlists in rules.ts, never evaluated code.
CREATE TABLE automation_rules (
  id                serial PRIMARY KEY,
  name              text NOT NULL UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 120),
  kind              text NOT NULL CHECK (kind IN ('incident', 'problem', 'change', 'request')),
  trigger           jsonb NOT NULL,
  conditions        jsonb NOT NULL DEFAULT '[]',
  actions           jsonb NOT NULL,
  enabled           boolean NOT NULL DEFAULT false,
  -- An agent's proposal (MCP propose_rule) lands disabled; a person enables it.
  proposed_by_agent boolean NOT NULL DEFAULT false,
  -- Who hears about it when the circuit breaker turns it off.
  owner_id          int REFERENCES users(id) ON DELETE SET NULL,
  -- Set when the circuit breaker turned the rule off; cleared when someone enables it again.
  tripped_at        timestamptz,
  created_by        int REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automation_rules_enabled_idx ON automation_rules (kind) WHERE enabled;

-- The outbox and the log in one: a row per rule and record change, queued in the change's transaction and run after
-- commit by a worker with a lease, so a rule never makes a person's save fail. Kept as the rule's run log.
CREATE TABLE rule_runs (
  id          bigserial PRIMARY KEY,
  rule_id     int NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  record_ref  text NOT NULL,
  -- What happened: { "type": "created" | "field_changed" | "status_changed", "field"?, "to"? }.
  event       jsonb NOT NULL,
  -- 0 for a person's change, one more for each rule in a chain.
  depth       smallint NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'matched', 'not_matched', 'skipped', 'failed')),
  lease_until timestamptz,
  attempts    smallint NOT NULL DEFAULT 0,
  -- Why it was skipped or failed, in a sentence.
  detail      text NOT NULL DEFAULT '',
  -- What each action did: [{ "type", "ok", "error"? }].
  results     jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX rule_runs_pending_idx ON rule_runs (id) WHERE status IN ('pending', 'running');
CREATE INDEX rule_runs_rule_idx ON rule_runs (rule_id, id DESC);
CREATE INDEX rule_runs_record_idx ON rule_runs (record_ref, rule_id, finished_at) WHERE status = 'matched';
-- A run names its record, so it is read only with the record. Queuing never depends on who saves (a portal or mail
-- intake has no viewer), and the worker updates runs as the system.
ALTER TABLE rule_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY rule_runs_visible ON rule_runs FOR SELECT USING (NOT kernel_ref_hidden(record_ref));
CREATE POLICY rule_runs_queue ON rule_runs FOR INSERT WITH CHECK (true);
CREATE POLICY rule_runs_work ON rule_runs FOR UPDATE USING (current_setting('kernel.viewer', true) = 'system');
CREATE POLICY rule_runs_prune ON rule_runs FOR DELETE USING (current_setting('kernel.viewer', true) = 'system');

-- A rule's changes are its own in the audit trail ("rule:<id>" as the channel).
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('user', 'api_token', 'mcp', 'integration', 'system', 'anonymous', 'portal', 'rule'));
