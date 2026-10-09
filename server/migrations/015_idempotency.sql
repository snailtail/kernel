-- Idempotency-Key support: a retried create returns the original response instead of creating a duplicate.
CREATE TABLE idempotency_keys (
  key        text NOT NULL,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route      text NOT NULL,
  status     int,
  body       jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
