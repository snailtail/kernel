-- Deliveries are claimed (status 'sending' with a lease) and sent outside the database transaction.
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_status_check;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_status_check CHECK (status IN ('pending', 'sending', 'ok', 'failed'));
ALTER TABLE webhook_deliveries ADD COLUMN locked_until timestamptz;
-- Teams Workflows (Adaptive Card); "teams" is the legacy Office 365 connector MessageCard.
ALTER TABLE webhooks DROP CONSTRAINT webhooks_format_check;
ALTER TABLE webhooks ADD CONSTRAINT webhooks_format_check CHECK (format IN ('json', 'slack', 'teams', 'teams_workflow'));
ALTER TABLE webhooks ADD COLUMN secret_rotated_at timestamptz;
