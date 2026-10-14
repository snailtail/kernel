-- The Kubernetes connector (#24): namespaces become CIs, and workloads show their images and readiness.
INSERT INTO ci_types (name, label, class, attributes) VALUES
  ('kubernetes_namespace', 'Kubernetes namespace', 'ci', '[]')
ON CONFLICT (name) DO NOTHING;
UPDATE ci_types SET attributes = '[{"key":"namespace","label":"Namespace","type":"string"},{"key":"kind","label":"Kind","type":"string"},{"key":"replicas","label":"Replicas","type":"number"},{"key":"ready_replicas","label":"Ready","type":"number"},{"key":"images","label":"Images","type":"string"},{"key":"schedule","label":"Schedule","type":"string"}]'
 WHERE name = 'kubernetes_workload';

ALTER TABLE connectors DROP CONSTRAINT connectors_type_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_type_check CHECK (type IN ('op5', 'kubernetes'));
