-- Follow-up actions on problems: owner, due date and status.
CREATE TABLE problem_actions (
  id           serial PRIMARY KEY,
  problem_id   int NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  owner_id     int REFERENCES users(id),
  due_date     date,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  change_ref   text NOT NULL DEFAULT '',
  created_by   int NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX problem_actions_problem_idx ON problem_actions (problem_id);
CREATE INDEX problem_actions_open_idx ON problem_actions (owner_id, due_date) WHERE status = 'open';

ALTER TABLE problem_activity DROP CONSTRAINT problem_activity_kind_check;
ALTER TABLE problem_activity ADD CONSTRAINT problem_activity_kind_check
  CHECK (kind IN ('created', 'comment', 'status', 'update', 'link', 'action', 'analysis', 'assessment'));
