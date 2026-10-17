-- A record's history includes entries elsewhere that name it by contents (a sync batch listing the CIs it created,
-- audit.ts queryAudit): `changes @> …` per entity type. Without an index that is a scan of the whole audit trail.
CREATE INDEX audit_log_changes_idx ON audit_log USING gin (changes jsonb_path_ops);
