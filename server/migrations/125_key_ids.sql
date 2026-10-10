-- Key ids (#63): keyed audit entries name the key that made them, so keys can be rotated and old entries still verify.
-- Version 2 entries (before key ids) were made with the key "k0" (KERNEL_SECRET_KEY).
ALTER TABLE audit_log ADD COLUMN key_id text;
