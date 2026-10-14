-- Confidential records (#61). Unlike restricted records (#53) they stay visible – people find them in lists and
-- searches – but their free text is masked for everyone except the people working on them, unless revealed: with a
-- reason, step-up and an audit entry, for 15 minutes.
ALTER TABLE problems ADD COLUMN classification text NOT NULL DEFAULT 'normal' CHECK (classification IN ('normal', 'confidential'));
ALTER TABLE incidents ADD COLUMN classification text NOT NULL DEFAULT 'normal' CHECK (classification IN ('normal', 'confidential'));
ALTER TABLE changes ADD COLUMN classification text NOT NULL DEFAULT 'normal' CHECK (classification IN ('normal', 'confidential'));

CREATE TABLE record_reveals (
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_type text NOT NULL CHECK (record_type IN ('problem', 'incident', 'change')),
  record_id   int NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, record_type, record_id)
);
