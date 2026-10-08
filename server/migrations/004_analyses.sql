-- Structured root cause analyses (5 Whys, Ishikawa, Kepner-Tregoe, timeline) attached to a problem.
CREATE TABLE problem_analyses (
  id         serial PRIMARY KEY,
  problem_id int NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  technique  text NOT NULL CHECK (technique IN ('five_whys', 'ishikawa', 'kepner_tregoe', 'timeline')),
  title      text NOT NULL DEFAULT '',
  data       jsonb NOT NULL DEFAULT '{}',
  conclusion text NOT NULL DEFAULT '',
  created_by int NOT NULL REFERENCES users(id),
  updated_by int NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX problem_analyses_problem_idx ON problem_analyses (problem_id);
