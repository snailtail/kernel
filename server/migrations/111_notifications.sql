-- Notifications for people (#48): an in-app notification centre, email (instant or a daily digest) and a personal
-- chat webhook. Each event reaches each person once (dedupe key); content is minimal (ref, title, one line, link).
CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event      text NOT NULL,
  ref        text NOT NULL DEFAULT '',
  title      text NOT NULL DEFAULT '',
  summary    text NOT NULL DEFAULT '',
  url        text NOT NULL DEFAULT '',
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Outbound deliveries per channel; a digest delivery collects several notifications.
CREATE TABLE notification_deliveries (
  id              bigserial PRIMARY KEY,
  notification_id bigint REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('email', 'chat', 'digest')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  error           text NOT NULL DEFAULT '',
  -- For a digest: the notifications created after this time.
  since           timestamptz,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_deliveries_due_idx ON notification_deliveries (next_attempt_at) WHERE status IN ('pending', 'sending');

-- Per-user settings: email on/off, digest, events, and an optional personal chat webhook (encrypted).
CREATE TABLE notification_settings (
  user_id     int PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email       boolean NOT NULL DEFAULT true,
  digest      boolean NOT NULL DEFAULT false,
  -- { "<event>": { "email": bool, "chat": bool } } overriding the defaults per event.
  events      jsonb NOT NULL DEFAULT '{}',
  chat_url    text,
  chat_format text NOT NULL DEFAULT 'slack' CHECK (chat_format IN ('slack', 'teams_workflow')),
  last_digest_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
