-- Retire proposals (#18): a CI that stays missing for a connector's retire_after_days is proposed for retirement.
-- A person retires it; nothing happens automatically and nothing is deleted. missing_since is kept by a trigger, so
-- every path that changes the status (sync, transition, bulk) keeps it right.
ALTER TABLE configuration_items ADD COLUMN missing_since timestamptz;

UPDATE configuration_items c SET missing_since = coalesce(
  (SELECT max(a.created_at) FROM ci_activity a WHERE a.ci_id = c.id AND a.kind = 'status' AND a.data->>'to' = 'missing'),
  c.updated_at)
WHERE c.status = 'missing';

CREATE FUNCTION kernel_ci_missing_since() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'missing' THEN
    NEW.missing_since := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.status <> 'missing' THEN
    NEW.missing_since := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER configuration_items_missing_since BEFORE INSERT OR UPDATE OF status ON configuration_items
  FOR EACH ROW EXECUTE FUNCTION kernel_ci_missing_since();

CREATE INDEX configuration_items_missing_idx ON configuration_items (missing_since) WHERE status = 'missing';

-- How long a CI this connector reports may stay missing before it is proposed. CIs from push sources use the
-- cmdb_reconciliation setting retire_after_days (default 14).
ALTER TABLE connectors ADD COLUMN retire_after_days int NOT NULL DEFAULT 14 CHECK (retire_after_days BETWEEN 1 AND 365);

-- When each missing CI is due for a retire proposal: the longest retire_after_days among its sources wins, so one
-- patient source keeps it off the list; push sources and CIs without sources use the setting.
CREATE VIEW ci_retire_due WITH (security_invoker = true) AS
SELECT c.id, c.missing_since, d.days AS retire_after_days, c.missing_since + d.days * interval '1 day' AS proposed_at
FROM configuration_items c
CROSS JOIN LATERAL (SELECT coalesce((SELECT (value->>'retire_after_days')::int FROM settings WHERE key = 'cmdb_reconciliation'), 14) AS def) g
CROSS JOIN LATERAL (
  SELECT coalesce(max(coalesce(k.retire_after_days, g.def)), g.def) AS days
  FROM ci_sources s LEFT JOIN connectors k ON k.source_system = s.source_system WHERE s.ci_id = c.id
) d
WHERE c.status = 'missing';
