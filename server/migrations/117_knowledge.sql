-- Knowledge articles (#47): how-tos, troubleshooting, known errors with their workaround, FAQs. An article published
-- from a known error follows the problem: its text is the problem's current symptoms, cause and workaround, and it is
-- retired when the problem is resolved.
CREATE SEQUENCE article_ref_seq;

CREATE TABLE articles (
  id                  serial PRIMARY KEY,
  ref                 text NOT NULL UNIQUE,
  title               text NOT NULL,
  body                text NOT NULL DEFAULT '',
  article_type        text NOT NULL DEFAULT 'how_to' CHECK (article_type IN ('how_to', 'troubleshooting', 'known_error', 'faq')),
  audience            text NOT NULL DEFAULT 'internal' CHECK (audience IN ('internal', 'end_users')),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  owner_id            int REFERENCES users(id),
  review_by           date,
  problem_id          int REFERENCES problems(id) ON DELETE SET NULL,
  synced_with_problem boolean NOT NULL DEFAULT false,
  source_incident_id  int REFERENCES incidents(id) ON DELETE SET NULL,
  helpful             int NOT NULL DEFAULT 0,
  not_helpful         int NOT NULL DEFAULT 0,
  used_count          int NOT NULL DEFAULT 0,
  created_by          int REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  published_at        timestamptz,
  retired_at          timestamptz,
  search              tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', body), 'B')) STORED
);
CREATE INDEX articles_search_idx ON articles USING gin (search);
CREATE INDEX articles_status_idx ON articles (status);
-- One synced article per known error.
CREATE UNIQUE INDEX articles_problem_sync_idx ON articles (problem_id) WHERE synced_with_problem;

CREATE TABLE article_cis (
  article_id int NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  ci_id      int NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, ci_id)
);
CREATE INDEX article_cis_ci_idx ON article_cis (ci_id);

CREATE TABLE article_activity (
  id         serial PRIMARY KEY,
  article_id int NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id    int REFERENCES users(id),
  kind       text NOT NULL CHECK (kind IN ('created', 'comment', 'status', 'update', 'link', 'feedback')),
  body       text NOT NULL DEFAULT '',
  data       jsonb NOT NULL DEFAULT '{}',
  channel    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX article_activity_article_idx ON article_activity (article_id, created_at);

-- "Was this helpful?" once per person and article (they can change their mind).
CREATE TABLE article_feedback (
  article_id int NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  helpful    boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, user_id)
);

-- Articles used to resolve incidents: how knowledge is measured.
CREATE TABLE incident_articles (
  incident_id int NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  article_id  int NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  used_by     int REFERENCES users(id),
  used_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, article_id)
);

CREATE TRIGGER articles_attachments AFTER DELETE ON articles FOR EACH ROW EXECUTE FUNCTION kernel_delete_attachments('article');


INSERT INTO settings (key, value) VALUES ('knowledge', '{"review_months": 12}') ON CONFLICT (key) DO NOTHING;

-- A known error's article follows the problem: the text is rebuilt from the problem whenever it changes, and the
-- article is retired when the problem is resolved or closed (a database rule, so every path – web, REST, MCP – keeps
-- them in step).
CREATE FUNCTION kernel_known_error_article_body(p problems) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws(E'\n\n',
    CASE WHEN p.description <> '' THEN E'## Symptoms\n\n' || p.description END,
    CASE WHEN p.root_cause <> '' THEN E'## Cause\n\n' || p.root_cause END,
    E'## Workaround\n\n' || CASE WHEN p.workaround <> '' THEN p.workaround ELSE '_No workaround yet._' END,
    '_This article follows known error ' || p.ref || ' and is retired when it is resolved._')
$$;

CREATE FUNCTION kernel_sync_known_error_articles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE articles SET title = NEW.title, body = kernel_known_error_article_body(NEW), updated_at = now()
   WHERE problem_id = NEW.id AND synced_with_problem AND status <> 'retired'
     AND (title IS DISTINCT FROM NEW.title OR body IS DISTINCT FROM kernel_known_error_article_body(NEW));
  IF NEW.status IN ('resolved', 'closed') AND OLD.status NOT IN ('resolved', 'closed') THEN
    WITH retired AS (
      UPDATE articles SET status = 'retired', retired_at = now(), updated_at = now()
       WHERE problem_id = NEW.id AND synced_with_problem AND status <> 'retired' RETURNING id
    )
    INSERT INTO article_activity (article_id, kind, body, data)
    SELECT id, 'status', 'Retired: ' || NEW.ref || ' is resolved', jsonb_build_object('to', 'retired', 'problem', NEW.ref) FROM retired;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER problems_known_error_articles AFTER UPDATE OF title, description, root_cause, workaround, status ON problems
  FOR EACH ROW EXECUTE FUNCTION kernel_sync_known_error_articles();
