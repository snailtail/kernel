-- Refs are 'INC' || lpad(seq, 6, '0'), which grows to seven digits after 999 999 (INC1000000). kernel_ref_hidden
-- matched exactly six, so such a ref was never hidden from a reader who may not see it (#227).

CREATE OR REPLACE FUNCTION kernel_ref_hidden(ref text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
BEGIN
  IF ref ~ '^PRB\d{6,}$' THEN
    SELECT 'problem' AS k, restricted, restricted_teams, team_id, assignee_id, created_by, id INTO r FROM problems WHERE problems.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^INC\d{6,}$' THEN
    SELECT 'incident' AS k, restricted, restricted_teams, team_id, assignee_id, created_by, id INTO r FROM incidents WHERE incidents.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^CHG\d{6,}$' THEN
    SELECT 'change' AS k, restricted, restricted_teams, team_id, assignee_id, created_by, id INTO r FROM changes WHERE changes.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^PIR\d{6,}$' THEN
    SELECT 'incident' AS k, i.restricted, i.restricted_teams, i.team_id, i.assignee_id, i.created_by, i.id INTO r
      FROM incident_reviews x JOIN incidents i ON i.id = x.incident_id WHERE x.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^IMP\d{6,}$' THEN
    SELECT 'improvement' AS k, restricted, restricted_teams, NULL::int AS team_id, owner_id AS assignee_id, created_by, id INTO r FROM improvements WHERE improvements.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^REQ\d{6,}$' THEN
    SELECT 'request' AS k, restricted, restricted_teams, NULL::int AS team_id, NULL::int AS assignee_id, created_by, id INTO r FROM requests WHERE requests.ref = kernel_ref_hidden.ref;
  ELSIF ref ~ '^WI\d{6,}$' THEN
    SELECT 'work_item' AS k, restricted, restricted_teams, team_id, assignee_id, created_by, id INTO r FROM work_items WHERE work_items.ref = kernel_ref_hidden.ref;
  ELSE
    RETURN false;
  END IF;
  IF r IS NULL THEN RETURN false; END IF;
  RETURN NOT kernel_can_see(r.k, r.restricted, r.restricted_teams, r.team_id, r.assignee_id, r.created_by, r.id);
END $$;
