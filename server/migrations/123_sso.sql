-- Single sign-on (#41): OpenID Connect with group-to-role mapping, and Cloudflare Access for installations behind it.
-- Accounts created by SSO have no usable password; local accounts stay as a break-glass option.
ALTER TABLE users ADD COLUMN sso_issuer text;
ALTER TABLE users ADD COLUMN sso_subject text;
CREATE UNIQUE INDEX users_sso_idx ON users (sso_issuer, sso_subject) WHERE sso_subject IS NOT NULL;

-- How a session was started, and whether its sign-in included a second factor that Kernel accepts: Kernel's own TOTP,
-- or an identity provider's MFA with evidence in the ID token (amr/acr). Access sign-in alone never counts.
ALTER TABLE sessions ADD COLUMN auth_method text NOT NULL DEFAULT 'password' CHECK (auth_method IN ('password', 'sso', 'access'));
ALTER TABLE sessions ADD COLUMN idp_mfa boolean NOT NULL DEFAULT false;
-- Cloudflare Access never signs in to a local administrator (break-glass) account unless allowed for that account.
ALTER TABLE users ADD COLUMN allow_access_login boolean NOT NULL DEFAULT false;

-- An authorization request in flight: one-time state, nonce and PKCE verifier, valid for ten minutes.
CREATE TABLE sso_requests (
  state         text PRIMARY KEY,
  nonce         text NOT NULL,
  code_verifier text NOT NULL,
  return_to     text NOT NULL DEFAULT '/',
  -- A step-up: the provider must have authenticated the person after this request started (auth_time).
  step_up       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('sso', '{"enabled": false, "issuer": "", "client_id": "", "scopes": "openid profile email", "groups_claim": "groups", "role_map": [], "team_map": [], "default_role": null, "local_login": "all", "label": "Sign in with SSO", "trust_idp_mfa": false, "mfa_acr_values": []}'),
  ('cf_access', '{"enabled": false, "team_domain": "", "audience": ""}')
ON CONFLICT (key) DO NOTHING;
