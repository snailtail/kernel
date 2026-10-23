-- Actions as their own register (#184): a follow-up action hangs off any record kind, not only a problem, so a
-- post-incident review's or an improvement's follow-ups live on their own record and problem management can become a
-- module. The parent is parent_kind + parent_id (a kind in the record registry, records.ts); existing actions keep
-- their id, history and fields, with parent_kind = 'problem'.
ALTER TABLE problem_actions RENAME TO actions;
ALTER SEQUENCE problem_actions_id_seq RENAME TO actions_id_seq;
ALTER INDEX problem_actions_pkey RENAME TO actions_pkey;
ALTER INDEX problem_actions_open_idx RENAME TO actions_open_idx;
ALTER TABLE actions ADD COLUMN parent_kind text NOT NULL DEFAULT 'problem'
  CHECK (parent_kind IN ('problem', 'incident', 'change', 'request', 'improvement', 'review'));
ALTER TABLE actions ADD COLUMN parent_id int;
UPDATE actions SET parent_id = problem_id;
ALTER TABLE actions ALTER COLUMN parent_id SET NOT NULL;
ALTER TABLE actions ALTER COLUMN parent_kind DROP DEFAULT;
DROP POLICY problem_actions_visible ON actions;
DROP TRIGGER problem_actions_live ON actions;
ALTER TABLE actions DROP COLUMN problem_id;
CREATE INDEX actions_parent_idx ON actions (parent_kind, parent_id);

-- Visibility (#53) follows the parent, as for every row that hangs off a record; nothing can be added to a record its
-- viewer cannot see.
CREATE POLICY actions_visible ON actions USING (CASE actions.parent_kind
  WHEN 'problem' THEN EXISTS (SELECT 1 FROM problems p WHERE p.id = actions.parent_id)
  WHEN 'incident' THEN EXISTS (SELECT 1 FROM incidents p WHERE p.id = actions.parent_id)
  WHEN 'change' THEN EXISTS (SELECT 1 FROM changes p WHERE p.id = actions.parent_id)
  WHEN 'request' THEN EXISTS (SELECT 1 FROM requests p WHERE p.id = actions.parent_id)
  WHEN 'improvement' THEN EXISTS (SELECT 1 FROM improvements p WHERE p.id = actions.parent_id)
  WHEN 'review' THEN EXISTS (SELECT 1 FROM incident_reviews p WHERE p.id = actions.parent_id)
  ELSE false END);

-- A parent's row goes, its actions go (the foreign key did this for problems).
CREATE FUNCTION kernel_drop_actions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM actions WHERE parent_kind = TG_ARGV[0] AND parent_id = OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER problems_drop_actions AFTER DELETE ON problems FOR EACH ROW EXECUTE FUNCTION kernel_drop_actions('problem');
CREATE TRIGGER incidents_drop_actions AFTER DELETE ON incidents FOR EACH ROW EXECUTE FUNCTION kernel_drop_actions('incident');
CREATE TRIGGER changes_drop_actions AFTER DELETE ON changes FOR EACH ROW EXECUTE FUNCTION kernel_drop_actions('change');
CREATE TRIGGER requests_drop_actions AFTER DELETE ON requests FOR EACH ROW EXECUTE FUNCTION kernel_drop_actions('request');
CREATE TRIGGER improvements_drop_actions AFTER DELETE ON improvements FOR EACH ROW EXECUTE FUNCTION kernel_drop_actions('improvement');
CREATE TRIGGER incident_reviews_drop_actions AFTER DELETE ON incident_reviews FOR EACH ROW EXECUTE FUNCTION kernel_drop_actions('review');

-- Live updates (#70): a change to an action is a change to its parent; a review's page follows its incident.
CREATE FUNCTION kernel_live_action() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pkind text := CASE WHEN TG_OP = 'DELETE' THEN OLD.parent_kind ELSE NEW.parent_kind END;
  pid int := CASE WHEN TG_OP = 'DELETE' THEN OLD.parent_id ELSE NEW.parent_id END;
BEGIN
  IF pkind = 'review' THEN
    SELECT 'incident', r.incident_id INTO pkind, pid FROM incident_reviews r WHERE r.id = pid;
  END IF;
  IF pid IS NOT NULL THEN
    PERFORM pg_notify('kernel_live', pkind || ':' || pid);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER actions_live AFTER INSERT OR UPDATE OR DELETE ON actions FOR EACH ROW EXECUTE FUNCTION kernel_live_action();

-- An action's changes go in its parent's history, as they always did for problems.
ALTER TABLE incident_activity DROP CONSTRAINT incident_activity_kind_check;
ALTER TABLE incident_activity ADD CONSTRAINT incident_activity_kind_check
  CHECK (kind IN ('created', 'comment', 'communication', 'status', 'update', 'link', 'sla', 'major', 'action'));
ALTER TABLE change_activity DROP CONSTRAINT change_activity_kind_check;
ALTER TABLE change_activity ADD CONSTRAINT change_activity_kind_check
  CHECK (kind IN ('created', 'comment', 'status', 'update', 'link', 'vote', 'action'));
ALTER TABLE request_activity DROP CONSTRAINT request_activity_kind_check;
ALTER TABLE request_activity ADD CONSTRAINT request_activity_kind_check
  CHECK (kind IN ('created', 'comment', 'status', 'update', 'link', 'task', 'approval', 'sla', 'action'));
ALTER TABLE improvement_activity DROP CONSTRAINT improvement_activity_kind_check;
ALTER TABLE improvement_activity ADD CONSTRAINT improvement_activity_kind_check
  CHECK (kind IN ('created', 'comment', 'status', 'update', 'link', 'action'));
