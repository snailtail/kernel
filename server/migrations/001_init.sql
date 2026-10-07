CREATE TABLE users (
  id            serial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  email         text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'problem_manager', 'analyst', 'viewer')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE categories (
  id     serial PRIMARY KEY,
  name   text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true
);
INSERT INTO categories (name) VALUES
  ('Application'), ('Infrastructure'), ('Network'), ('Database'),
  ('Security'), ('Supplier'), ('Process'), ('Other');

CREATE SEQUENCE problem_ref_seq;

CREATE TABLE problems (
  id               serial PRIMARY KEY,
  ref              text NOT NULL UNIQUE DEFAULT 'PRB' || lpad(nextval('problem_ref_seq')::text, 6, '0'),
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new', 'analysis', 'known_error', 'resolved', 'closed')),
  category_id      int REFERENCES categories(id),
  affected_service text NOT NULL DEFAULT '',
  detection        text NOT NULL DEFAULT 'reactive' CHECK (detection IN ('reactive', 'proactive')),
  impact           smallint NOT NULL DEFAULT 3 CHECK (impact BETWEEN 1 AND 3),
  urgency          smallint NOT NULL DEFAULT 3 CHECK (urgency BETWEEN 1 AND 3),
  priority         smallint GENERATED ALWAYS AS (impact + urgency - 1) STORED,
  is_major         boolean NOT NULL DEFAULT false,
  assignee_id      int REFERENCES users(id),
  created_by       int NOT NULL REFERENCES users(id),
  root_cause       text NOT NULL DEFAULT '',
  workaround       text NOT NULL DEFAULT '',
  resolution       text NOT NULL DEFAULT '',
  closure_code     text CHECK (closure_code IN ('resolved', 'workaround_accepted', 'duplicate', 'cancelled', 'no_fix')),
  major_review     text NOT NULL DEFAULT '',
  known_error_at   timestamptz,
  resolved_at      timestamptz,
  closed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  search           tsvector GENERATED ALWAYS AS (
                     to_tsvector('simple',
                       ref || ' ' || title || ' ' || description || ' ' || affected_service || ' ' ||
                       root_cause || ' ' || workaround || ' ' || resolution)
                   ) STORED
);
CREATE INDEX problems_status_idx ON problems (status);
CREATE INDEX problems_assignee_idx ON problems (assignee_id);
CREATE INDEX problems_search_idx ON problems USING gin (search);

-- Related records, usually in external tools: incidents (reactive), monitoring events
-- (proactive), changes implementing the fix, and related problem records.
CREATE TABLE problem_links (
  id         serial PRIMARY KEY,
  problem_id int NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('incident', 'event', 'change', 'problem')),
  reference  text NOT NULL,
  system     text NOT NULL DEFAULT '',
  url        text NOT NULL DEFAULT '',
  note       text NOT NULL DEFAULT '',
  created_by int NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (problem_id, kind, reference)
);

CREATE TABLE problem_activity (
  id         serial PRIMARY KEY,
  problem_id int NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  user_id    int REFERENCES users(id),
  kind       text NOT NULL CHECK (kind IN ('created', 'comment', 'status', 'update', 'link')),
  body       text NOT NULL DEFAULT '',
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX problem_activity_problem_idx ON problem_activity (problem_id, created_at);

-- Personal API tokens, used by MCP clients and scripts (Authorization: Bearer krn_...)
CREATE TABLE api_tokens (
  id           serial PRIMARY KEY,
  user_id      int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  prefix       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz
);
