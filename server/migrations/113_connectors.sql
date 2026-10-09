-- Connector framework (#18): scheduled pull connectors and the push contract share one sync path. Credentials are
-- encrypted and write-only; runs never overlap (a lease per connector); a snapshot that looks wrong never marks CIs
-- missing; every run is logged with counts and errors.
CREATE TABLE connectors (
  id               serial PRIMARY KEY,
  type             text NOT NULL CHECK (type IN ('op5')),
  name             text NOT NULL UNIQUE,
  -- The CMDB source system this connector owns; nothing else may write it.
  source_system    text NOT NULL UNIQUE,
  -- Non-secret settings (base URL, default CI type, what to sync…).
  config           jsonb NOT NULL DEFAULT '{}',
  -- Encrypted credentials (e.g. {"username": …, "password": …}); never returned by the API.
  secret           text,
  -- Private addresses/CIDRs this connector may reach (e.g. the OP5 server on the LAN).
  private_allow    text[] NOT NULL DEFAULT '{}',
  schedule_minutes int NOT NULL DEFAULT 60 CHECK (schedule_minutes BETWEEN 5 AND 10080),
  enabled          boolean NOT NULL DEFAULT true,
  next_run_at      timestamptz NOT NULL DEFAULT now(),
  running_until    timestamptz,
  created_by       int REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connector_runs (
  id           bigserial PRIMARY KEY,
  connector_id int NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  trigger      text NOT NULL CHECK (trigger IN ('schedule', 'manual', 'push')),
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'refused')),
  counts       jsonb NOT NULL DEFAULT '{}',
  errors       jsonb NOT NULL DEFAULT '[]',
  message      text NOT NULL DEFAULT '',
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX connector_runs_connector_idx ON connector_runs (connector_id, started_at DESC);

-- Reconciliation: how many full syncs in a row a source has missed a CI, and which source owns each attribute.
ALTER TABLE ci_sources ADD COLUMN missed_syncs int NOT NULL DEFAULT 0;
ALTER TABLE configuration_items ADD COLUMN attribute_sources jsonb NOT NULL DEFAULT '{}';

INSERT INTO settings (key, value) VALUES ('cmdb_reconciliation', '{"missing_after": 3, "max_drop_percent": 50, "attribute_precedence": {}}')
ON CONFLICT (key) DO NOTHING;
