-- The VMware vCenter connector (#20): datacenters become CIs, and hosts, VMs, clusters and datastores keep what
-- vCenter says about them when their type has room for it.
INSERT INTO ci_types (name, label, class, attributes) VALUES
  ('datacenter', 'Datacenter', 'ci', '[{"key":"platform","label":"Platform","type":"string"},{"key":"location","label":"Location","type":"string"}]')
ON CONFLICT (name) DO NOTHING;

UPDATE ci_types t SET attributes = t.attributes || (
  SELECT coalesce(jsonb_agg(a), '[]') FROM jsonb_array_elements(x.attrs) a
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.attributes) e WHERE e->>'key' = a->>'key')
)
FROM (VALUES
  ('virtual_machine', '[{"key":"power_state","label":"Power state","type":"string"},{"key":"instance_uuid","label":"Instance UUID","type":"string"},{"key":"host","label":"Host","type":"string"},{"key":"cluster","label":"Cluster","type":"string"},{"key":"folder","label":"Folder","type":"string"},{"key":"resource_pool","label":"Resource pool","type":"string"}]'::jsonb),
  ('physical_server', '[{"key":"power_state","label":"Power state","type":"string"},{"key":"connection_state","label":"Connection state","type":"string"},{"key":"cluster","label":"Cluster","type":"string"}]'),
  ('cluster', '[{"key":"ha_enabled","label":"HA enabled","type":"string"},{"key":"drs_enabled","label":"DRS enabled","type":"string"}]'),
  ('storage', '[{"key":"filesystem","label":"Filesystem","type":"string"},{"key":"free_tb","label":"Free (TB)","type":"number"}]')
) AS x(name, attrs)
WHERE t.name = x.name;

ALTER TABLE connectors DROP CONSTRAINT connectors_type_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_type_check CHECK (type IN ('op5', 'vcenter', 'kubernetes', 'imap', 'msgraph'));
