-- Live updates (#70). A change to a record, or to anything hanging off it (comments, actions, links, CIs…), sends
-- "kind:id" on the channel kernel_live. Nothing else goes in the payload: the server checks for each listener whether
-- they may see the record, and the browser refetches through the normal API. NOTIFY is delivered at commit (never
-- for a rolled-back change), and identical payloads in one transaction are delivered once.
CREATE FUNCTION kernel_live_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  id bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    EXECUTE format('SELECT ($1).%I', TG_ARGV[1]) INTO id USING OLD;
  ELSE
    EXECUTE format('SELECT ($1).%I', TG_ARGV[1]) INTO id USING NEW;
  END IF;
  IF id IS NOT NULL THEN
    PERFORM pg_notify('kernel_live', TG_ARGV[0] || ':' || id);
  END IF;
  RETURN NULL;
END $$;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('problems', 'problem', 'id'), ('problem_activity', 'problem', 'problem_id'), ('problem_actions', 'problem', 'problem_id'),
      ('problem_links', 'problem', 'problem_id'), ('problem_cis', 'problem', 'problem_id'), ('problem_analyses', 'problem', 'problem_id'),
      ('incidents', 'incident', 'id'), ('incident_activity', 'incident', 'incident_id'), ('incident_links', 'incident', 'incident_id'),
      ('incident_cis', 'incident', 'incident_id'), ('incident_people', 'incident', 'incident_id'),
      ('changes', 'change', 'id'), ('change_activity', 'change', 'change_id'), ('change_cis', 'change', 'change_id'),
      ('change_links', 'change', 'change_id'), ('change_votes', 'change', 'change_id'),
      ('configuration_items', 'ci', 'id'), ('ci_activity', 'ci', 'ci_id')
    ) AS x(tbl, kind, col)
  LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION kernel_live_notify(%L, %L)',
      t.tbl || '_live', t.tbl, t.kind, t.col);
  END LOOP;
END $$;
