-- Token scopes (least privilege) and last used address; existing tokens keep full access.
ALTER TABLE api_tokens ADD COLUMN scopes text[] NOT NULL DEFAULT '{read,write,mcp}';
ALTER TABLE api_tokens ADD COLUMN last_used_ip text NOT NULL DEFAULT '';
UPDATE api_tokens t SET scopes = '{ingest}' FROM users u WHERE u.id = t.user_id AND u.role = 'integration';
-- Login challenges allow a limited number of wrong codes.
ALTER TABLE mfa_challenges ADD COLUMN attempts int NOT NULL DEFAULT 0;
