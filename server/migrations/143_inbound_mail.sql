-- Inbound email (#48): a mailbox is a connector (IMAP, or Microsoft Graph for Exchange Online). New mail becomes an
-- incident; a reply from a verified participant becomes a comment; anything else waits in "Inbound to review".
ALTER TABLE connectors DROP CONSTRAINT connectors_type_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_type_check CHECK (type IN ('op5', 'kubernetes', 'imap', 'msgraph'));

ALTER TABLE incidents DROP CONSTRAINT incidents_source_check;
ALTER TABLE incidents ADD CONSTRAINT incidents_source_check CHECK (source IN ('user', 'event', 'api', 'mcp', 'email'));

-- The Message-ID of each email Kernel sends, so a reply's In-Reply-To/References find the record it answers.
ALTER TABLE notification_deliveries ADD COLUMN message_id text;
CREATE INDEX notification_deliveries_message_id_idx ON notification_deliveries (message_id) WHERE message_id IS NOT NULL;

-- Every message a mailbox handed over, once per Message-ID: a rerun never handles the same mail twice. The text is
-- kept only while a message waits for review (and cleared when it is decided).
CREATE TABLE inbound_mail (
  id           bigserial PRIMARY KEY,
  connector_id int REFERENCES connectors(id) ON DELETE SET NULL,
  message_id   text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  from_address text NOT NULL DEFAULT '',
  from_name    text NOT NULL DEFAULT '',
  subject      text NOT NULL DEFAULT '',
  body         text NOT NULL DEFAULT '',
  -- The receiving server's Authentication-Results showed DMARC (or aligned SPF/DKIM) pass.
  verified     boolean NOT NULL DEFAULT false,
  outcome      text NOT NULL CHECK (outcome IN ('incident', 'comment', 'review', 'ignored', 'discarded')),
  reason       text NOT NULL DEFAULT '',
  -- The record a reply named (subject or headers), and the incident the mail became or was added to.
  ref          text NOT NULL DEFAULT '',
  incident_id  int REFERENCES incidents(id) ON DELETE SET NULL,
  attachments  int NOT NULL DEFAULT 0,
  decided_by   int REFERENCES users(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  UNIQUE (connector_id, message_id)
);
CREATE INDEX inbound_mail_review_idx ON inbound_mail (received_at DESC) WHERE outcome = 'review';
CREATE INDEX inbound_mail_sender_idx ON inbound_mail (connector_id, lower(from_address), received_at);

-- Mail added to an incident is hidden with it (119_visibility.sql); mail waiting for review belongs to no record yet.
ALTER TABLE inbound_mail ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_mail FORCE ROW LEVEL SECURITY;
CREATE POLICY inbound_mail_visible ON inbound_mail USING (incident_id IS NULL OR EXISTS (SELECT 1 FROM incidents i WHERE i.id = incident_id));
