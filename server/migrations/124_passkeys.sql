-- Passkeys (WebAuthn, #75): passwordless sign-in, a second factor and step-up. User verification is always required,
-- so a passkey sign-in counts as two factors. Challenges are server-side and single-use.
CREATE TABLE webauthn_credentials (
  id            serial PRIMARY KEY,
  user_id       int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key    bytea NOT NULL,
  counter       bigint NOT NULL DEFAULT 0,
  transports    text[] NOT NULL DEFAULT '{}',
  name          text NOT NULL DEFAULT 'Passkey',
  backed_up     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX webauthn_credentials_user_idx ON webauthn_credentials (user_id);

CREATE TABLE webauthn_challenges (
  id         serial PRIMARY KEY,
  user_id    int REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('register', 'login', 'second_factor', 'step_up')),
  challenge  text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes'
);

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_auth_method_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_auth_method_check CHECK (auth_method IN ('password', 'sso', 'access', 'passkey'));

-- Token rotation without downtime: the predecessor stays valid for a short overlap.
ALTER TABLE api_tokens ADD COLUMN rotated_to int REFERENCES api_tokens(id) ON DELETE SET NULL;
