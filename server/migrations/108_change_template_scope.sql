-- Standard change templates have a scope, and pipeline accounts are bound to their templates (#29 review), so a
-- pre-approved template cannot be used to change critical services without authorisation.
ALTER TABLE change_templates ADD COLUMN max_risk text NOT NULL DEFAULT 'low' CHECK (max_risk IN ('low', 'medium', 'high'));
ALTER TABLE change_templates ADD COLUMN ci_types text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN change_templates int[] NOT NULL DEFAULT '{}';
