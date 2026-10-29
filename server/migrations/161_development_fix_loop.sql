-- Closing the loop between a problem and its fix (#167, epic #164), part 2.
--
-- How many days a deployed fix is watched for new incidents before Kernel suggests resolving the problem. Empty means
-- the default, 7 days (changes/problem-fix.ts).
ALTER TABLE problems ADD COLUMN fix_observation_days smallint CHECK (fix_observation_days BETWEEN 1 AND 90);

-- The changes that carry a problem's permanent fix: linked to the problem itself, or delivering one of its bugs or
-- stories (work_item_links to both). security_invoker: a reader sees the fixes their row-level security lets them see,
-- and the links' own policy already hides a link to a record they cannot see.
CREATE VIEW problem_fixes WITH (security_invoker = true) AS
SELECT c.problem_id, c.id AS change_id, NULL::text AS work_item_ref FROM changes c WHERE c.problem_id IS NOT NULL
UNION
SELECT l.problem_id, c.id, NULL FROM problem_links l JOIN changes c ON c.ref = upper(l.reference)
WHERE l.kind = 'change' AND l.system IN ('', 'Kernel')
UNION
SELECT p.id, c.id, w.ref
FROM work_item_links lp
JOIN problems p ON p.ref = lp.reference
JOIN work_items w ON w.id = lp.work_item_id AND w.status <> 'removed'
JOIN work_item_links lc ON lc.work_item_id = w.id AND lc.kind = 'change' AND lc.system IN ('', 'Kernel')
JOIN changes c ON c.ref = lc.reference
WHERE lp.kind = 'problem' AND lp.system IN ('', 'Kernel');

-- When a problem's fix is in: the last successful fix change ended, no fix change failed or was rolled back after it,
-- and none of the problem's bugs or stories is still open.
CREATE VIEW problem_fix_deployed WITH (security_invoker = true) AS
SELECT f.problem_id,
       max(c.actual_end) FILTER (WHERE c.outcome = 'successful') AS deployed_at,
       (array_agg(c.ref ORDER BY c.actual_end DESC) FILTER (WHERE c.outcome = 'successful'))[1] AS change_ref
FROM problem_fixes f JOIN changes c ON c.id = f.change_id
WHERE c.outcome IS NOT NULL AND c.actual_end IS NOT NULL
GROUP BY f.problem_id
HAVING max(c.actual_end) FILTER (WHERE c.outcome = 'successful') > coalesce(max(c.actual_end) FILTER (WHERE c.outcome <> 'successful'), '-infinity')
   AND NOT EXISTS (
     SELECT 1 FROM problems p
     JOIN work_item_links l ON l.kind = 'problem' AND l.system IN ('', 'Kernel') AND l.reference = p.ref
     JOIN work_items w ON w.id = l.work_item_id
     WHERE p.id = f.problem_id AND w.status NOT IN ('done', 'removed'));
