-- Two-factor authentication (TOTP). The secret is encrypted with KERNEL_SECRET_KEY.
ALTER TABLE users ADD COLUMN mfa_secret text;
ALTER TABLE users ADD COLUMN mfa_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN mfa_last_step bigint NOT NULL DEFAULT 0;

CREATE TABLE mfa_recovery_codes (
  id        serial PRIMARY KEY,
  user_id   int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at   timestamptz
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id);

-- Logins waiting for the second factor.
CREATE TABLE mfa_challenges (
  token_hash text PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- Recent re-authentication, required for sensitive actions (step-up).
ALTER TABLE sessions ADD COLUMN reauth_at timestamptz NOT NULL DEFAULT now();

-- Devices where the user signed in successfully; they may still sign in while the account is locked by others' failures.
CREATE TABLE known_devices (
  token_hash   text PRIMARY KEY,
  user_id      int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES ('mfa_required_roles', '[]') ON CONFLICT DO NOTHING;
