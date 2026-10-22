-- Automation rules (#49), part 2: time triggers, recommended rules and the webhook action.

-- A time trigger fires once per record and window: the time the record entered a status, or an action and its due
-- date. The scan may run on several replicas or twice; the key keeps it to one run.
ALTER TABLE rule_runs ADD COLUMN window_key text;
CREATE UNIQUE INDEX rule_runs_window_idx ON rule_runs (rule_id, record_ref, window_key) WHERE window_key IS NOT NULL;

-- Recommended rules ship disabled; one click enables them. The key says which one it is.
ALTER TABLE automation_rules ADD COLUMN recommended text UNIQUE;

INSERT INTO automation_rules (name, kind, trigger, conditions, actions, recommended) VALUES
  ('Close resolved incidents after 5 days', 'incident',
   '{"type": "in_status_for", "status": "resolved", "hours": 120}',
   '[{"field": "requester_reopened", "op": "is", "value": false}, {"field": "is_major", "op": "is", "value": false}]',
   '[{"type": "transition", "to": "closed"}]', 'close_resolved'),
  ('Remind the owner of actions due tomorrow', 'problem',
   '{"type": "due_in", "hours": 24}', '[]',
   '[{"type": "notify", "users": [], "teams": [], "roles": ["owner"]}]', 'remind_actions'),
  ('Escalate an unassigned P1 to the team lead after 15 minutes', 'incident',
   '{"type": "in_status_for", "status": "new", "hours": 0.25}',
   '[{"field": "priority", "op": "is", "value": 1}, {"field": "assignee", "op": "is_empty"}]',
   '[{"type": "notify", "users": [], "teams": [], "roles": ["team_lead"]}]', 'escalate_p1'),
  ('Remind the approver of a request after 2 days', 'request',
   '{"type": "in_status_for", "status": "awaiting_approval", "hours": 48}', '[]',
   '[{"type": "notify", "users": [], "teams": [], "roles": ["approvers"]}]', 'remind_approver');
