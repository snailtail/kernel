-- Modules and first-run setup (#36). Every practice except problem management can be switched off; nothing is
-- deleted when it is. The setup wizard runs once on a fresh installation; existing installations count as set up.
INSERT INTO settings (key, value) VALUES ('modules', '{"incident": true, "change": true, "event": true, "cmdb": true, "sla": true}')
ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value)
SELECT 'setup', jsonb_build_object('completed', EXISTS (SELECT 1 FROM problems) OR EXISTS (SELECT 1 FROM incidents) OR EXISTS (SELECT 1 FROM configuration_items))
ON CONFLICT (key) DO NOTHING;

-- Demo data created by the setup wizard, so it can be removed in one action.
CREATE TABLE demo_records (
  kind      text NOT NULL CHECK (kind IN ('problem', 'incident', 'change', 'ci')),
  record_id int NOT NULL,
  PRIMARY KEY (kind, record_id)
);

-- Templates that prefill new incidents and problems (common issues).
CREATE TABLE record_templates (
  id         serial PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('incident', 'problem')),
  name       text NOT NULL,
  fields     jsonb NOT NULL DEFAULT '{}',
  active     boolean NOT NULL DEFAULT true,
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, name)
);
