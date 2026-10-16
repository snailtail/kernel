-- Problem candidates with a rule, a reason and evidence (part 1 of #31). Candidates are computed on read; only what
-- has to persist is stored here: each rule's settings, decisions (dismiss or snooze) per candidate key, and
-- candidates reported by external analysis (an agent reading logs, a monitoring tool's own trend analysis).

-- One row per rule, replacing the single 'candidate_rule' setting. Rules without a row run with their defaults.
CREATE TABLE candidate_rules (
  rule       text PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT true,
  settings   jsonb NOT NULL DEFAULT '{}',
  updated_by int REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO candidate_rules (rule, settings) SELECT 'recurring_records', value FROM settings WHERE key = 'candidate_rule';
DELETE FROM settings WHERE key = 'candidate_rule';

-- A decision about one candidate (rule + subject). A dismissal covers the evidence it was made on (record keys such
-- as "i:INC000123"), so the candidate comes back only when new evidence is enough for the rule on its own. A snooze
-- hides the candidate until a time, whatever arrives meanwhile.
CREATE TABLE candidate_decisions (
  key        text PRIMARY KEY,
  rule       text NOT NULL,
  decision   text NOT NULL CHECK (decision IN ('dismissed', 'snoozed')),
  until      timestamptz,
  evidence   text[] NOT NULL DEFAULT '{}',
  reason     text NOT NULL,
  decided_by int REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((decision = 'snoozed') = (until IS NOT NULL))
);

-- Candidates reported from outside (REST/MCP), idempotent on the reporter's own key. The evidence is a size-capped
-- snapshot with secrets redacted on the way in (#61). problem_ref is set once a problem was logged or linked from it.
CREATE TABLE reported_candidates (
  id                     bigserial PRIMARY KEY,
  source                 text NOT NULL,
  external_key           text NOT NULL,
  title                  text NOT NULL,
  reason                 text NOT NULL,
  ci_id                  int REFERENCES configuration_items(id) ON DELETE SET NULL,
  service                text NOT NULL DEFAULT '',
  evidence               jsonb NOT NULL DEFAULT '{}',
  contains_personal_data boolean NOT NULL DEFAULT false,
  problem_ref            text,
  reported_by            int REFERENCES users(id) ON DELETE SET NULL,
  first_reported_at      timestamptz NOT NULL DEFAULT now(),
  last_reported_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_key)
);
CREATE INDEX reported_candidates_open_idx ON reported_candidates (last_reported_at) WHERE problem_ref IS NULL;

-- The rules that look back over resolved incidents read these.
CREATE INDEX incidents_unlinked_resolved_idx ON incidents (resolved_at) WHERE problem_id IS NULL AND resolved_at IS NOT NULL;
