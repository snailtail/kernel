-- Sensitive data (#61): records whose text holds personal data are marked, for retention (#53) and AI handling.
ALTER TABLE problems ADD COLUMN contains_personal_data boolean NOT NULL DEFAULT false;
ALTER TABLE incidents ADD COLUMN contains_personal_data boolean NOT NULL DEFAULT false;
ALTER TABLE changes ADD COLUMN contains_personal_data boolean NOT NULL DEFAULT false;
INSERT INTO settings (key, value) VALUES ('sensitive_data', '{"secrets": "redact", "flag_personal": true, "flag_ips": false}') ON CONFLICT (key) DO NOTHING;
