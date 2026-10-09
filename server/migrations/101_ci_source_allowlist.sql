-- Integration accounts may only write CIs for the source systems an administrator allowed (#16 review).
ALTER TABLE users ADD COLUMN ci_source_systems text[] NOT NULL DEFAULT '{}';
