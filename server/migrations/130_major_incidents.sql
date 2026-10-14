-- Major incidents (#108): who leads, where to talk, when the next update is due, a timeline of key moments, and
-- related incidents that are resolved together with the major one.

ALTER TABLE incidents
  ADD COLUMN major_declared_at   timestamptz,
  ADD COLUMN major_lead_id       int REFERENCES users(id),
  ADD COLUMN major_comms_id      int REFERENCES users(id),
  -- A Teams/Meet/Zoom link or a phone number.
  ADD COLUMN major_bridge        text NOT NULL DEFAULT '',
  ADD COLUMN major_update_minutes int CHECK (major_update_minutes BETWEEN 5 AND 1440),
  ADD COLUMN major_next_update_at timestamptz,
  -- The update period the comms lead was last told is overdue (one notice per period).
  ADD COLUMN major_overdue_notified_for timestamptz,
  -- Who runs the post-incident review (#109), and by when; asked when the major incident stands down.
  ADD COLUMN pir_owner_id        int REFERENCES users(id),
  ADD COLUMN pir_due             date,
  -- A related incident (same outage, reported again) under its parent; one level only.
  ADD COLUMN parent_id           int REFERENCES incidents(id) ON DELETE SET NULL,
  -- Resolved together with the parent unless someone unticks it.
  ADD COLUMN resolve_with_parent boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT incidents_parent_not_self CHECK (parent_id IS DISTINCT FROM id);

CREATE INDEX incidents_parent_idx ON incidents (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX incidents_major_due_idx ON incidents (major_next_update_at) WHERE is_major AND major_next_update_at IS NOT NULL;

-- Anyone may mark any entry a key moment; the timeline shows key kinds and marked entries.
ALTER TABLE incident_activity ADD COLUMN key_moment boolean NOT NULL DEFAULT false;
ALTER TABLE incident_activity DROP CONSTRAINT incident_activity_kind_check;
ALTER TABLE incident_activity ADD CONSTRAINT incident_activity_kind_check
  CHECK (kind IN ('created', 'comment', 'communication', 'status', 'update', 'link', 'sla', 'major'));

-- Existing major incidents get a declaration time so the header can show how long they have run.
UPDATE incidents SET major_declared_at = created_at WHERE is_major AND major_declared_at IS NULL;
