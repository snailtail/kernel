-- A neutral manager role (#171): Kernel favours no practice, so `problem_manager` becomes `manager`. The API accepts
-- the old name as an alias for one release (workflow.ts legacyRole); stored values move here.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE users SET role = 'manager' WHERE role = 'problem_manager';
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'manager', 'analyst', 'viewer', 'integration'));

-- Roles kept in settings: the MFA policy, the SSO group mapping and the start page per role.
UPDATE settings SET value = (SELECT coalesce(jsonb_agg(CASE WHEN r = '"problem_manager"' THEN '"manager"'::jsonb ELSE r END), '[]') FROM jsonb_array_elements(value) r)
  WHERE key = 'mfa_required_roles' AND jsonb_typeof(value) = 'array';
UPDATE settings SET value = jsonb_set(value, '{role_map}', (SELECT coalesce(jsonb_agg(CASE WHEN m->>'role' = 'problem_manager' THEN jsonb_set(m, '{role}', '"manager"') ELSE m END), '[]') FROM jsonb_array_elements(value->'role_map') m))
  WHERE key = 'sso' AND jsonb_typeof(value->'role_map') = 'array';
UPDATE settings SET value = (value - 'problem_manager') || jsonb_build_object('manager', value->'problem_manager')
  WHERE key = 'start_pages' AND value ? 'problem_manager';

-- Row-level visibility: managers see team-scoped work of every team (same rule as 119, with the new name).
CREATE OR REPLACE FUNCTION kernel_can_see(kind text, is_restricted boolean, allowed_teams int[], row_team int, row_assignee int, row_creator int, row_id int)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  v text := coalesce(current_setting('kernel.viewer', true), '');
  uid int;
  role text;
  teams int[];
  scoped text[];
  flags text;
BEGIN
  IF v = 'system' THEN RETURN true; END IF;
  IF v NOT LIKE 'u:%' THEN
    RETURN NOT is_restricted;
  END IF;
  uid := split_part(v, ':', 2)::int;
  role := split_part(v, ':', 3);
  teams := coalesce(nullif(string_to_array(split_part(v, ':', 4), ','), '{}')::int[], '{}');
  scoped := string_to_array(split_part(v, ':', 5), ',');
  flags := split_part(v, ':', 6);
  IF is_restricted THEN
    IF flags LIKE '%noai%' THEN RETURN false; END IF;
    -- coalesce: a missing assignee or creator (NULL) must count as "no", never as unknown.
    IF NOT coalesce(row_assignee = uid OR row_creator = uid OR allowed_teams && teams
            OR (role = 'admin' AND EXISTS (SELECT 1 FROM visibility_breakglass b WHERE b.user_id = uid AND b.record_type = kind AND b.record_id = row_id AND b.expires_at > now())), false) THEN
      RETURN false;
    END IF;
  END IF;
  IF kind = ANY(scoped) AND role NOT IN ('admin', 'manager') THEN
    RETURN coalesce(row_team IS NULL OR row_team = ANY(teams) OR row_assignee = uid OR row_creator = uid, false);
  END IF;
  RETURN true;
END $$;
