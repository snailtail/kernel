-- Saved list views (#110, promised in #38): a named filter, sort and set of columns for a practice list, kept per user,
-- shared with a team (owned by the team, its leads edit it) or with everyone. Built-in views live in code (views.ts).
CREATE TABLE list_views (
  id         serial PRIMARY KEY,
  list       text NOT NULL CHECK (list IN ('problems', 'actions', 'incidents', 'changes', 'alerts', 'known_errors', 'knowledge', 'cis', 'candidates')),
  name       text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  scope      text NOT NULL CHECK (scope IN ('personal', 'team', 'everyone')),
  owner_id   int REFERENCES users(id) ON DELETE CASCADE,
  team_id    int REFERENCES teams(id) ON DELETE CASCADE,
  -- The list's query string (filters and sort), e.g. "status=known_error&sort=updated".
  query      text NOT NULL DEFAULT '' CHECK (length(query) <= 500),
  -- Visible columns, in order; empty means the list's default columns.
  columns    text[] NOT NULL DEFAULT '{}',
  created_by int REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'personal') = (owner_id IS NOT NULL)),
  CHECK ((scope = 'team') = (team_id IS NOT NULL))
);
CREATE UNIQUE INDEX list_views_personal_name ON list_views (owner_id, list, lower(name)) WHERE scope = 'personal';
CREATE UNIQUE INDEX list_views_team_name ON list_views (team_id, list, lower(name)) WHERE scope = 'team';
CREATE UNIQUE INDEX list_views_everyone_name ON list_views (list, lower(name)) WHERE scope = 'everyone';

-- The view a user opens a list with: a saved view or a built-in one ("builtin:<key>").
CREATE TABLE list_view_defaults (
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list    text NOT NULL,
  view_id int REFERENCES list_views(id) ON DELETE CASCADE,
  builtin text,
  PRIMARY KEY (user_id, list),
  CHECK ((view_id IS NULL) <> (builtin IS NULL))
);

-- Views users saved in their preferences move here, so nobody loses them.
INSERT INTO list_views (list, name, scope, owner_id, query, created_by)
SELECT v->>'page', left(trim(v->>'name'), 60), 'personal', u.id, left(coalesce(v->>'query', ''), 500), u.id
FROM users u, jsonb_array_elements(CASE WHEN jsonb_typeof(u.preferences->'saved_views') = 'array' THEN u.preferences->'saved_views' ELSE '[]' END) v
WHERE v->>'page' IN ('problems', 'actions') AND length(trim(coalesce(v->>'name', ''))) > 0
ON CONFLICT DO NOTHING;
UPDATE users SET preferences = preferences - 'saved_views' WHERE preferences ? 'saved_views';
