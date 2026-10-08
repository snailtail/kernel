-- Users watching problems (creators and assignees automatically).
CREATE TABLE problem_watchers (
  problem_id int NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (problem_id, user_id)
);
CREATE INDEX problem_watchers_user_idx ON problem_watchers (user_id);
INSERT INTO problem_watchers (problem_id, user_id) SELECT id, created_by FROM problems ON CONFLICT DO NOTHING;
INSERT INTO problem_watchers (problem_id, user_id) SELECT id, assignee_id FROM problems WHERE assignee_id IS NOT NULL ON CONFLICT DO NOTHING;

-- Outbound webhooks. Deliveries are queued in the same transaction as the change (outbox) and sent by a worker.
CREATE TABLE webhooks (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  url        text NOT NULL,
  format     text NOT NULL DEFAULT 'json' CHECK (format IN ('json', 'slack', 'teams')),
  secret     text NOT NULL,
  events     text[] NOT NULL DEFAULT '{}',
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id              bigserial PRIMARY KEY,
  webhook_id      int NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event           text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'failed')),
  attempts        int NOT NULL DEFAULT 0,
  response_status int,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_webhook_idx ON webhook_deliveries (webhook_id, created_at DESC);

ALTER TABLE problem_actions ADD COLUMN overdue_notified_at timestamptz;
