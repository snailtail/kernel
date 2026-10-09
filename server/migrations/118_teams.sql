-- Teams and assignment groups (#42). Records name a team (team_id) plus an optional assignee. Histories and the audit
-- trail refer to team ids and show the current name. The text column incidents.assignment_group is compatibility only
-- (to be removed once API clients and event rules use team ids): it always shows the team's name, and API clients or event rules
-- that send a group name are matched to the team of that name.
CREATE TABLE teams (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  email       text NOT NULL DEFAULT '',
  -- 'none': the team picks work from its queue; 'round_robin': new work goes to the member with the least open work.
  auto_assign text NOT NULL DEFAULT 'none' CHECK (auto_assign IN ('none', 'round_robin')),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX teams_name_idx ON teams (lower(name));

-- A user can be in several teams; leads manage their own team's members (and #53 will scope visibility by team).
CREATE TABLE team_members (
  team_id  int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id  int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     text NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user_idx ON team_members (user_id);

-- The services and CIs a team supports: new work on them goes to the team by default.
CREATE TABLE team_cis (
  team_id int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  ci_id   int NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, ci_id)
);
CREATE INDEX team_cis_ci_idx ON team_cis (ci_id);

-- Existing free-text groups become teams, so nothing is lost.
INSERT INTO teams (name)
SELECT DISTINCT ON (lower(g)) g FROM (
  SELECT trim(assignment_group) AS g FROM incidents WHERE trim(assignment_group) <> ''
  UNION SELECT trim(assignment_group) FROM event_rules WHERE trim(assignment_group) <> ''
) x ORDER BY lower(g), g
ON CONFLICT DO NOTHING;

ALTER TABLE incidents ADD COLUMN team_id int REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE incidents ADD COLUMN team_hops int NOT NULL DEFAULT 0;
UPDATE incidents i SET team_id = t.id FROM teams t WHERE lower(t.name) = lower(trim(i.assignment_group));
CREATE INDEX incidents_team_idx ON incidents (team_id) WHERE team_id IS NOT NULL;

-- Event rules route by team id, so renaming a team never breaks routing.
ALTER TABLE event_rules ADD COLUMN team_id int REFERENCES teams(id) ON DELETE SET NULL;
UPDATE event_rules r SET team_id = t.id FROM teams t WHERE lower(t.name) = lower(trim(r.assignment_group));
CREATE FUNCTION kernel_event_rule_team() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.team_id IS NULL AND trim(NEW.assignment_group) <> '' THEN
    NEW.team_id := (SELECT id FROM teams WHERE lower(name) = lower(trim(NEW.assignment_group)));
  END IF;
  IF NEW.team_id IS NOT NULL THEN NEW.assignment_group := (SELECT name FROM teams WHERE id = NEW.team_id); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_rules_team BEFORE INSERT OR UPDATE OF team_id, assignment_group ON event_rules FOR EACH ROW EXECUTE FUNCTION kernel_event_rule_team();

ALTER TABLE problems ADD COLUMN team_id int REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE changes ADD COLUMN team_id int REFERENCES teams(id) ON DELETE SET NULL;
CREATE INDEX problems_team_idx ON problems (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX changes_team_idx ON changes (team_id) WHERE team_id IS NOT NULL;

-- Keeps incidents.assignment_group (text) and team_id in step, and counts reassignments between teams ("hops").
CREATE FUNCTION kernel_incident_team() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.team_id IS NOT DISTINCT FROM OLD.team_id AND NEW.assignment_group IS DISTINCT FROM OLD.assignment_group THEN
    NEW.team_id := (SELECT id FROM teams WHERE lower(name) = lower(trim(NEW.assignment_group)));
  ELSIF TG_OP = 'INSERT' AND NEW.team_id IS NULL AND trim(NEW.assignment_group) <> '' THEN
    NEW.team_id := (SELECT id FROM teams WHERE lower(name) = lower(trim(NEW.assignment_group)));
  END IF;
  IF NEW.team_id IS NOT NULL THEN
    NEW.assignment_group := (SELECT name FROM teams WHERE id = NEW.team_id);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.team_id IS NOT NULL AND NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    NEW.team_hops := OLD.team_hops + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER incidents_team BEFORE INSERT OR UPDATE OF team_id, assignment_group ON incidents FOR EACH ROW EXECUTE FUNCTION kernel_incident_team();

-- Renaming a team renames it on its incidents.
CREATE FUNCTION kernel_team_renamed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE incidents SET assignment_group = NEW.name WHERE team_id = NEW.id AND assignment_group IS DISTINCT FROM NEW.name;
  UPDATE event_rules SET assignment_group = NEW.name WHERE team_id = NEW.id AND assignment_group IS DISTINCT FROM NEW.name;
  RETURN NEW;
END $$;
CREATE TRIGGER teams_renamed AFTER UPDATE OF name ON teams FOR EACH ROW EXECUTE FUNCTION kernel_team_renamed();
