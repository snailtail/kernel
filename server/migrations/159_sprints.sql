-- Sprints, the board, burndown and retrospectives (#166, epic #164). A sprint belongs to one team and goes
-- planned → active → completed, with at most one active sprint per team. It is not a record kind: it needs no ref of
-- its own, and what people write in it (the goal, the review, the retrospective) is the team's.
CREATE TABLE sprints (
  id               serial PRIMARY KEY,
  team_id          int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  goal             text NOT NULL DEFAULT '',
  starts_on        date NOT NULL,
  ends_on          date NOT NULL,
  -- Story points the team expects to finish: planning shows the sum against it, nothing stops going over.
  capacity         smallint CHECK (capacity BETWEEN 1 AND 999),
  status           text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed')),
  review_notes     text NOT NULL DEFAULT '',
  started_at       timestamptz,
  started_by       int REFERENCES users(id),
  completed_at     timestamptz,
  completed_by     int REFERENCES users(id),
  created_by       int REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);
CREATE UNIQUE INDEX sprints_one_active_idx ON sprints (team_id) WHERE status = 'active';
CREATE INDEX sprints_team_idx ON sprints (team_id, starts_on DESC);

-- The sprint an item is in now. A done item keeps the sprint it was finished in; unfinished items leave when the
-- sprint is completed.
ALTER TABLE work_items ADD COLUMN sprint_id int REFERENCES sprints(id) ON DELETE SET NULL;
CREATE INDEX work_items_sprint_idx ON work_items (sprint_id) WHERE sprint_id IS NOT NULL;

-- Each stay of an item in a sprint, for the burndown and the unplanned share: when it came and went, whether it came
-- after the start, and where it went at the end. On completion the points and the time it was done are kept, so a
-- finished sprint's numbers do not move when an item is re-estimated or reopened later.
CREATE TABLE sprint_items (
  id              serial PRIMARY KEY,
  sprint_id       int NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  work_item_id    int NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  added_at        timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  unplanned       boolean NOT NULL DEFAULT false,
  outcome         text CHECK (outcome IN ('done', 'backlog', 'next_sprint')),
  -- The item's points when the sprint started (what the team committed to), and when it left or the sprint ended.
  points_at_start smallint,
  points          smallint,
  done_at         timestamptz
);
CREATE UNIQUE INDEX sprint_items_current_idx ON sprint_items (sprint_id, work_item_id) WHERE removed_at IS NULL;
CREATE INDEX sprint_items_item_idx ON sprint_items (work_item_id);

-- The retrospective: what went well, what was hard, and what to change. A "to change" item can become an improvement
-- (#52) with one click.
CREATE TABLE sprint_retro_items (
  id             serial PRIMARY KEY,
  sprint_id      int NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('went_well', 'hard', 'to_change')),
  body           text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  improvement_id int REFERENCES improvements(id) ON DELETE SET NULL,
  created_by     int REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sprint_retro_items_idx ON sprint_retro_items (sprint_id, created_at);

-- Kanban teams work without sprints: WIP limits per board column ({"in_progress": 4}), a warning and not a block.
ALTER TABLE work_definitions ADD COLUMN wip_limits jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(wip_limits) = 'object');

ALTER TABLE work_item_activity DROP CONSTRAINT work_item_activity_kind_check;
ALTER TABLE work_item_activity ADD CONSTRAINT work_item_activity_kind_check CHECK (kind IN ('created', 'comment', 'status', 'update', 'link', 'backlog', 'sprint'));

ALTER TABLE improvements DROP CONSTRAINT improvements_source_check;
ALTER TABLE improvements ADD CONSTRAINT improvements_source_check CHECK (source IN ('review', 'problem', 'service_review', 'idea', 'retrospective'));

-- Visibility follows the team when work items are team-scoped (#53); an item's stays follow the item.
ALTER TABLE sprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE sprints FORCE ROW LEVEL SECURITY;
CREATE POLICY sprints_visible ON sprints USING (NOT kernel_scoped('work_item') OR team_id = ANY(kernel_teams()));
ALTER TABLE sprint_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sprint_items FORCE ROW LEVEL SECURITY;
CREATE POLICY sprint_items_visible ON sprint_items USING (EXISTS (SELECT 1 FROM work_items w WHERE w.id = work_item_id) AND EXISTS (SELECT 1 FROM sprints s WHERE s.id = sprint_id));
ALTER TABLE sprint_retro_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sprint_retro_items FORCE ROW LEVEL SECURITY;
CREATE POLICY sprint_retro_items_visible ON sprint_retro_items USING (EXISTS (SELECT 1 FROM sprints s WHERE s.id = sprint_id));

