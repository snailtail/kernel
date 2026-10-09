-- People, organisations and affected users (#39). A person is a contact and needs no login; a login account can be
-- linked to one. Activity logs refer to people by id only, so erasing a person anonymises one row and every history
-- stays intact (ADR 0001).
CREATE TABLE organisations (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  kind        text NOT NULL DEFAULT 'internal' CHECK (kind IN ('internal', 'customer')),
  description text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE people (
  id              serial PRIMARY KEY,
  name            text NOT NULL,
  email           text,
  phone           text NOT NULL DEFAULT '',
  title           text NOT NULL DEFAULT '',
  department      text NOT NULL DEFAULT '',
  location        text NOT NULL DEFAULT '',
  organisation_id int REFERENCES organisations(id) ON DELETE SET NULL,
  manager_id      int REFERENCES people(id) ON DELETE SET NULL,
  is_vip          boolean NOT NULL DEFAULT false,
  active          boolean NOT NULL DEFAULT true,
  external_id     text,
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv', 'directory')),
  user_id         int UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  erased_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  search          tsvector GENERATED ALWAYS AS (to_tsvector('simple', name || ' ' || coalesce(email, '') || ' ' || department)) STORED
);
CREATE UNIQUE INDEX people_email_idx ON people (lower(email)) WHERE email IS NOT NULL AND erased_at IS NULL;
CREATE INDEX people_search_idx ON people USING gin (search);
CREATE INDEX people_org_idx ON people (organisation_id);

-- Which organisations consume which services (for communication and impact).
CREATE TABLE organisation_services (
  organisation_id int NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ci_id           int NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  PRIMARY KEY (organisation_id, ci_id)
);

-- Services: who owns them, and whether they have end users (only then are affected users asked for).
ALTER TABLE configuration_items ADD COLUMN has_end_users boolean NOT NULL DEFAULT false;
ALTER TABLE configuration_items ADD COLUMN business_owner_id int REFERENCES people(id) ON DELETE SET NULL;
ALTER TABLE configuration_items ADD COLUMN technical_contact_id int REFERENCES people(id) ON DELETE SET NULL;

-- Incidents: the caller and the people affected.
ALTER TABLE incidents ADD COLUMN caller_id int REFERENCES people(id) ON DELETE SET NULL;
CREATE INDEX incidents_caller_idx ON incidents (caller_id) WHERE caller_id IS NOT NULL;
CREATE TABLE incident_people (
  incident_id int NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  person_id   int NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  added_by    int REFERENCES users(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, person_id)
);
CREATE INDEX incident_people_person_idx ON incident_people (person_id);

-- Changes: organisations to inform.
CREATE TABLE change_organisations (
  change_id       int NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  organisation_id int NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  PRIMARY KEY (change_id, organisation_id)
);

INSERT INTO settings (key, value) VALUES ('people_priority', '{"affected_for_high_impact": 10, "vip_raises_impact": true}') ON CONFLICT (key) DO NOTHING;
