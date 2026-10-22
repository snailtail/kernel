-- The self-service portal (#45), part 2: one click on how it went, once per closed ticket.
CREATE TABLE portal_feedback (
  id          serial PRIMARY KEY,
  person_id   int REFERENCES people(id) ON DELETE SET NULL,
  incident_id int UNIQUE REFERENCES incidents(id) ON DELETE CASCADE,
  request_id  int UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  rating      text NOT NULL CHECK (rating IN ('good', 'okay', 'bad')),
  comment     text NOT NULL DEFAULT '' CHECK (length(comment) <= 2000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((incident_id IS NULL) <> (request_id IS NULL))
);
CREATE INDEX portal_feedback_created_idx ON portal_feedback (created_at);
-- A rating names its record, so it is visible only with the record.
ALTER TABLE portal_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_feedback_visible ON portal_feedback USING (
  (incident_id IS NULL OR EXISTS (SELECT 1 FROM incidents i WHERE i.id = incident_id))
  AND (request_id IS NULL OR EXISTS (SELECT 1 FROM requests r WHERE r.id = request_id))
);
