-- Security fix (#77): stored responses could contain one-time secrets (tokens, webhook/TOTP secrets, recovery
-- codes). Drop everything stored so far; idempotency is now opt-in for record creation only, with a fingerprint.
DELETE FROM idempotency_keys;
ALTER TABLE idempotency_keys ADD COLUMN fingerprint text NOT NULL DEFAULT '';
