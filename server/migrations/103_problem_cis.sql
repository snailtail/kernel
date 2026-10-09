-- Problems and known errors point at real CIs and services (#26); external records can name the CI they concern.
CREATE TABLE problem_cis (
  problem_id int NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  ci_id      int NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  added_by   int REFERENCES users(id),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (problem_id, ci_id)
);
CREATE INDEX problem_cis_ci_idx ON problem_cis (ci_id);

ALTER TABLE external_records ADD COLUMN ci_id int REFERENCES configuration_items(id) ON DELETE SET NULL;
CREATE INDEX external_records_ci_idx ON external_records (ci_id, occurred_at) WHERE ci_id IS NOT NULL;

-- Free text that names exactly one CI or service (case-insensitive) becomes a real link; the rest stays text.
WITH unique_names AS (
  SELECT lower(name) AS name, min(id) AS id FROM configuration_items WHERE status <> 'retired' GROUP BY lower(name) HAVING count(*) = 1
)
INSERT INTO problem_cis (problem_id, ci_id, added_by)
SELECT p.id, u.id, p.created_by FROM problems p JOIN unique_names u ON u.name = lower(trim(p.affected_service))
ON CONFLICT DO NOTHING;

WITH unique_names AS (
  SELECT lower(name) AS name, min(id) AS id FROM configuration_items WHERE status <> 'retired' GROUP BY lower(name) HAVING count(*) = 1
)
UPDATE external_records r SET ci_id = u.id FROM unique_names u WHERE r.ci_id IS NULL AND u.name = lower(trim(r.service));

-- Problem links made from the CI side (#16) become affected CIs.
INSERT INTO problem_cis (problem_id, ci_id, added_by, added_at)
SELECT p.id, l.ci_id, l.created_by, l.created_at FROM ci_links l JOIN problems p ON p.ref = upper(l.reference) WHERE l.kind = 'problem'
ON CONFLICT DO NOTHING;
DELETE FROM ci_links l USING problems p WHERE l.kind = 'problem' AND p.ref = upper(l.reference);
