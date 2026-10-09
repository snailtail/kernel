-- When each event source token was issued, so old tokens are visible and rotated (#30 review).
ALTER TABLE event_sources ADD COLUMN token_created_at timestamptz NOT NULL DEFAULT now();
UPDATE event_sources SET token_created_at = created_at;
