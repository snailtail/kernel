-- Single sign-on (#41): OpenID Connect with group-to-role mapping, and Cloudflare Access for installations behind it.
-- Accounts created by SSO have no usable password; local accounts stay as a break-glass option.
ALTER TABLE users ADD COLUMN sso_issuer text;
ALTER TABLE users ADD COLUMN sso_subject text;
CREATE UNIQUE INDEX users_sso_idx ON users (sso_issuer, sso_subject) WHERE sso_subject IS NOT NULL;

-- How a session was started, so the second-factor requirement can rely on the identity provider for SSO sessions.
ALTER TABLE sessions ADD COLUMN auth_method text NOT NULL DEFAULT 'password' CHECK (auth_method IN ('password', 'sso', 'access'));

-- An authorization request in flight: one-time state, nonce and PKCE verifier, valid for ten minutes.
CREATE TABLE sso_requests (
  state         text PRIMARY KEY,
  nonce         text NOT NULL,
  code_verifier text NOT NULL,
  return_to     text NOT NULL DEFAULT '/',
  created_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('sso', '{"enabled": false, "issuer": "", "client_id": "", "scopes": "openid profile email", "groups_claim": "groups", "role_map": [], "team_map": [], "default_role": null, "local_login": "all", "label": "Sign in with SSO", "idp_enforces_mfa": true}'),
  ('cf_access', '{"enabled": false, "team_domain": "", "audience": ""}')
ON CONFLICT (key) DO NOTHING;
