-- Hash algorithm per entry: 1 = SHA-256 chain, 2 = HMAC-SHA-256 keyed from KERNEL_SECRET_KEY.
ALTER TABLE audit_log ADD COLUMN hash_version smallint NOT NULL DEFAULT 1;
