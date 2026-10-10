-- Service status and stakeholder communication (#46). Kernel suggests a status from open incidents, alerts and
-- maintenance; a person sets it. The public page (off by default) shows only services and messages people chose to
-- publish, never incident details.
CREATE TABLE service_status (
  ci_id       int PRIMARY KEY REFERENCES configuration_items(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'operational' CHECK (status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance')),
  -- The public page shows only what a person published: a curated name and description (never the CI name), and the
  -- status set when publishing. The internal status above changes with every update; this one only when published.
  public      boolean NOT NULL DEFAULT false,
  public_name text NOT NULL DEFAULT '',
  public_description text NOT NULL DEFAULT '',
  public_status text NOT NULL DEFAULT 'operational' CHECK (public_status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance')),
  CONSTRAINT service_status_public_name CHECK (NOT public OR public_name <> ''),
  updated_by  int REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE status_updates (
  id          serial PRIMARY KEY,
  incident_id int REFERENCES incidents(id) ON DELETE SET NULL,
  ci_ids      int[] NOT NULL DEFAULT '{}',
  phase       text NOT NULL CHECK (phase IN ('investigating', 'identified', 'monitoring', 'resolved', 'maintenance')),
  status      text CHECK (status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance')),
  message     text NOT NULL,
  -- Published on the public page (written for customers: no internal details).
  public      boolean NOT NULL DEFAULT false,
  retracted_at timestamptz,
  created_by  int REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX status_updates_created_idx ON status_updates (created_at DESC);
CREATE INDEX status_updates_incident_idx ON status_updates (incident_id) WHERE incident_id IS NOT NULL;

-- Updates tied to an incident follow its visibility (#53); service-wide updates are visible to all staff.
ALTER TABLE status_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_updates FORCE ROW LEVEL SECURITY;
CREATE POLICY status_updates_visible ON status_updates USING (incident_id IS NULL OR public OR EXISTS (SELECT 1 FROM incidents i WHERE i.id = incident_id));

INSERT INTO settings (key, value) VALUES ('status_page', '{"public_enabled": false, "title": "Service status"}') ON CONFLICT (key) DO NOTHING;
