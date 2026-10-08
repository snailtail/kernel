-- Per-user preferences (theme, guided mode, ...). Missing keys mean "use the default".
ALTER TABLE users ADD COLUMN preferences jsonb NOT NULL DEFAULT '{}';
