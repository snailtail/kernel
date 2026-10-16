-- Post-incident reviews as a record type of their own (#35): a ref (PIR000012), so get_record, search, history,
-- links, comments and deep links work for them as for every other record. The incident's ref keeps working too.
-- Every review gets one, restricted incidents' included, so the backfill runs as the system viewer.
SELECT set_config('kernel.viewer', 'system', true);
CREATE SEQUENCE incident_review_ref_seq;
ALTER TABLE incident_reviews ADD COLUMN ref text;
UPDATE incident_reviews r SET ref = 'PIR' || lpad(x.n::text, 6, '0')
  FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM incident_reviews) x WHERE x.id = r.id;
SELECT setval('incident_review_ref_seq', (SELECT count(*) FROM incident_reviews) + 1, false);
ALTER TABLE incident_reviews
  ALTER COLUMN ref SET DEFAULT 'PIR' || lpad(nextval('incident_review_ref_seq')::text, 6, '0'),
  ALTER COLUMN ref SET NOT NULL,
  ADD CONSTRAINT incident_reviews_ref_key UNIQUE (ref);
SELECT set_config('kernel.viewer', '', true);

-- A review is as visible as its incident: a hidden incident's review answers like one that does not exist.
CREATE OR REPLACE FUNCTION kernel_ref_hidden(ref text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
BEGIN
  IF ref ~ '^PRB\d{6}$' THEN
    SELECT 'problem' AS k, restricted, restricted_teams, team_id, assignee_id, created_by, id INTO r FROM problems WHERE problems.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^INC\d{6}$' THEN
    SELECT 'incident' AS k, restricted, restricted_teams, team_id, assignee_id, created_by, id INTO r FROM incidents WHERE incidents.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^CHG\d{6}$' THEN
    SELECT 'change' AS k, restricted, restricted_teams, team_id, assignee_id, created_by, id INTO r FROM changes WHERE changes.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^PIR\d{6}$' THEN
    SELECT 'incident' AS k, i.restricted, i.restricted_teams, i.team_id, i.assignee_id, i.created_by, i.id INTO r
      FROM incident_reviews x JOIN incidents i ON i.id = x.incident_id WHERE x.ref = kernel_ref_hidden.ref;
  ELSE
    RETURN false;
  END IF;
  IF r IS NULL THEN RETURN false; END IF;
  RETURN NOT kernel_can_see(r.k, r.restricted, r.restricted_teams, r.team_id, r.assignee_id, r.created_by, r.id);
END $$;
