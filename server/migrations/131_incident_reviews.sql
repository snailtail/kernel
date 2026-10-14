-- Post-incident reviews (#109): a short, blameless look back on an incident that produces problems, actions and
-- knowledge. One per incident; created when a major incident is resolved, optional for any other.
CREATE TABLE incident_reviews (
  id             serial PRIMARY KEY,
  incident_id    int NOT NULL UNIQUE REFERENCES incidents(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'draft', 'published', 'waived')),
  owner_id       int REFERENCES users(id),
  due            date,
  attendees      text NOT NULL DEFAULT '',
  -- The guided template, in Markdown.
  what_happened  text NOT NULL DEFAULT '',
  impact_summary text NOT NULL DEFAULT '',
  went_well      text NOT NULL DEFAULT '',
  was_hard       text NOT NULL DEFAULT '',
  lucky          text NOT NULL DEFAULT '',
  waived_reason  text NOT NULL DEFAULT '',
  published_at   timestamptz,
  published_by   int REFERENCES users(id),
  created_by     int REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_reviews_open_idx ON incident_reviews (owner_id, due) WHERE status IN ('scheduled', 'draft');

-- Contributing factors (→ a problem), follow-ups (→ an action) and detection or response gaps, each linked both ways.
CREATE TABLE incident_review_items (
  id          serial PRIMARY KEY,
  review_id   int NOT NULL REFERENCES incident_reviews(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('factor', 'follow_up', 'gap')),
  body        text NOT NULL,
  problem_id  int REFERENCES problems(id) ON DELETE SET NULL,
  action_id   int REFERENCES problem_actions(id) ON DELETE SET NULL,
  created_by  int REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_review_items_review_idx ON incident_review_items (review_id);
CREATE INDEX incident_review_items_problem_idx ON incident_review_items (problem_id) WHERE problem_id IS NOT NULL;

-- The review owner and date asked for when a major incident is resolved (#108) now live on the review.
INSERT INTO incident_reviews (incident_id, owner_id, due, created_at)
  SELECT id, pir_owner_id, pir_due, coalesce(resolved_at, now()) FROM incidents
  WHERE is_major AND status IN ('resolved', 'closed');
ALTER TABLE incidents DROP COLUMN pir_owner_id, DROP COLUMN pir_due;

-- Visibility (#53): a review and its items follow their incident, like everything else attached to a record.
ALTER TABLE incident_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY incident_reviews_visible ON incident_reviews USING (EXISTS (SELECT 1 FROM incidents i WHERE i.id = incident_id));
ALTER TABLE incident_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_review_items FORCE ROW LEVEL SECURITY;
CREATE POLICY incident_review_items_visible ON incident_review_items USING (EXISTS (SELECT 1 FROM incident_reviews r WHERE r.id = review_id));
