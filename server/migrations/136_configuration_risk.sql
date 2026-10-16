-- Configuration risk as problem candidates (part 3 of #31).

-- End-of-life versions: a small table people keep, matched against synced CI attributes (os; engine/product + version).
-- No external service is called. The rows below are well-known dates to start from; edit or remove them freely.
CREATE TABLE eol_versions (
  id         serial PRIMARY KEY,
  product    text NOT NULL CHECK (length(product) BETWEEN 1 AND 100),
  version    text NOT NULL CHECK (length(version) BETWEEN 1 AND 50),
  eol_date   date NOT NULL,
  note       text NOT NULL DEFAULT '',
  updated_by int REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX eol_versions_identity ON eol_versions (lower(product), lower(version));
INSERT INTO eol_versions (product, version, eol_date, note) VALUES
  ('Ubuntu', '18.04', '2023-05-31', 'End of standard support'),
  ('Ubuntu', '20.04', '2025-05-31', 'End of standard support'),
  ('CentOS', '7', '2024-06-30', 'End of life'),
  ('RHEL', '7', '2024-06-30', 'End of maintenance support'),
  ('Debian', '10', '2024-06-30', 'End of LTS'),
  ('Windows Server', '2012 R2', '2023-10-10', 'End of extended support'),
  ('PostgreSQL', '12', '2024-11-21', 'Final release'),
  ('PostgreSQL', '13', '2025-11-13', 'Final release');

-- Events suppressed by a maintenance window are counted apart, so planned work does not look like a rising trend.
ALTER TABLE event_daily ADD COLUMN suppressed int NOT NULL DEFAULT 0;
