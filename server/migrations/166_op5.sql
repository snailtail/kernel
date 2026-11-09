-- The OP5 Monitor connector (#19): OP5 services become monitoring checks on their host, and hosts keep what OP5 says
-- about them (alias, check command, notes) when their type has room for it.
INSERT INTO ci_types (name, label, class, attributes) VALUES
  ('monitoring_check', 'Monitoring check', 'ci', '[{"key":"host","label":"Host","type":"string"},{"key":"check_command","label":"Check command","type":"string"},{"key":"notes","label":"Notes","type":"string"},{"key":"notes_url","label":"Notes URL","type":"string"}]')
ON CONFLICT (name) DO NOTHING;

UPDATE ci_types t SET attributes = t.attributes || (
  SELECT coalesce(jsonb_agg(a), '[]') FROM jsonb_array_elements('[{"key":"alias","label":"Alias","type":"string"},{"key":"check_command","label":"Check command","type":"string"},{"key":"notes","label":"Notes","type":"string"},{"key":"notes_url","label":"Notes URL","type":"string"}]') a
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.attributes) e WHERE e->>'key' = a->>'key')
)
WHERE t.name IN ('physical_server', 'virtual_machine', 'network_device');
