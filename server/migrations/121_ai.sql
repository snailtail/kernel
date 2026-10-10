-- Pluggable language model providers (#68). Nothing is sent anywhere until an administrator configures a provider
-- and routes a task to it. Each provider says where it runs and which data classes it may receive (ADR 0003).
CREATE TABLE ai_providers (
  id                   serial PRIMARY KEY,
  name                 text NOT NULL UNIQUE,
  kind                 text NOT NULL CHECK (kind IN ('openai_compatible', 'anthropic', 'openai', 'google')),
  base_url             text NOT NULL DEFAULT '',
  api_key              text,
  models               text[] NOT NULL DEFAULT '{}',
  -- on_prem: runs in the organisation's own environment (Ollama, vLLM…); cloud: a provider's service.
  location             text NOT NULL DEFAULT 'cloud' CHECK (location IN ('on_prem', 'cloud')),
  -- What may be sent: 'internal' (work data), 'personal' (names of people involved), 'restricted' (restricted records).
  data_classes         text[] NOT NULL DEFAULT '{internal}',
  private_allow        text[] NOT NULL DEFAULT '{}',
  ca_pem               text,
  monthly_token_budget int NOT NULL DEFAULT 1000000 CHECK (monthly_token_budget >= 0),
  enabled              boolean NOT NULL DEFAULT true,
  created_by           int REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Restricted records only ever go to models in the organisation's own environment.
  CONSTRAINT ai_restricted_on_prem CHECK (NOT ('restricted' = ANY(data_classes)) OR location = 'on_prem')
);

CREATE TABLE ai_usage (
  provider_id   int NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  month         date NOT NULL,
  calls         int NOT NULL DEFAULT 0,
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_id, month)
);

-- Which provider and model does which task; a task without a route is unavailable.
INSERT INTO settings (key, value) VALUES ('ai_routing', '{}') ON CONFLICT (key) DO NOTHING;
