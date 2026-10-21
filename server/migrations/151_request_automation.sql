-- Service requests, part 2 (#44): automation and the requester.
-- A fulfilment task can be done by a person (manual), by a standard change made from the item's template (change:
-- the change's outcome completes it), or by an outgoing webhook (webhook: the receiver calls back with a token bound
-- to that task, of which only the SHA-256 is stored; single use, expires).
ALTER TABLE request_tasks
  ADD COLUMN kind                text NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual', 'change', 'webhook')),
  ADD COLUMN change_id           int REFERENCES changes(id) ON DELETE SET NULL,
  ADD COLUMN webhook_id          int REFERENCES webhooks(id) ON DELETE SET NULL,
  ADD COLUMN callback_hash       bytea,
  ADD COLUMN callback_expires_at timestamptz,
  ADD COLUMN callback_used_at    timestamptz;
CREATE UNIQUE INDEX request_tasks_callback_idx ON request_tasks (callback_hash) WHERE callback_hash IS NOT NULL;
CREATE INDEX request_tasks_change_idx ON request_tasks (change_id) WHERE change_id IS NOT NULL;

-- Separation of duties (review of #44 part 1): by default the user who logs a request is not one of its approvers.
ALTER TABLE request_items ADD COLUMN logger_may_approve boolean NOT NULL DEFAULT false;

-- The requester hears about their request: people with an account through their notifications, everyone else by
-- mail with a one-click unsubscribe (status-subscriptions.ts signs it). A person can stop it.
ALTER TABLE people ADD COLUMN request_mail boolean NOT NULL DEFAULT true;

CREATE TABLE request_mail (
  id              bigserial PRIMARY KEY,
  request_id      int NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  person_id       int REFERENCES people(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('received', 'approved', 'rejected', 'fulfilled', 'cancelled')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  sent_at         timestamptz,
  error           text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, kind)
);
CREATE INDEX request_mail_due_idx ON request_mail (next_attempt_at) WHERE status IN ('pending', 'sending');
ALTER TABLE request_mail ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_mail FORCE ROW LEVEL SECURITY;
CREATE POLICY request_mail_visible ON request_mail USING (EXISTS (SELECT 1 FROM requests r WHERE r.id = request_id));
