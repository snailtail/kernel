-- Subscriptions to service status (#46). Staff follow services and hear through their own channels (#48). People
-- outside sign up on the public page for public services only, confirmed by a single-use link (double opt-in), and
-- contacts of organisations bound to a service hear about updates a person published. Outside recipients only ever
-- get the published text under public names.

-- Staff following a service: the bell, and email or chat by their own notification settings.
CREATE TABLE status_follows (
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ci_id      int NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ci_id)
);
CREATE INDEX status_follows_ci_idx ON status_follows (ci_id);

-- Email subscribers from the public page. Only confirmed rows receive updates; unconfirmed ones are removed after a
-- week. The confirmation token is stored as a hash only, minted when the mail is sent. ci_ids empty = every public
-- service. Unsubscribing deletes the row; the log keeps its deliveries without the address.
CREATE TABLE status_subscribers (
  id                 serial PRIMARY KEY,
  email              text NOT NULL,
  ci_ids             int[] NOT NULL DEFAULT '{}',
  -- What the last sign-up asked for; it replaces ci_ids when that sign-up is confirmed.
  pending_ci_ids     int[],
  confirm_hash       text,
  confirm_expires_at timestamptz,
  confirmed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX status_subscribers_email_idx ON status_subscribers (lower(email));

-- Contacts who hear about published updates on the services their organisation uses (organisation_services).
ALTER TABLE people ADD COLUMN status_contact boolean NOT NULL DEFAULT false;

-- Webhooks can carry published status updates (event status.published), for some services or all public ones.
ALTER TABLE webhooks ADD COLUMN ci_ids int[] NOT NULL DEFAULT '{}';

-- The outbox for mail to people outside, and the communication log of who was told what and when. A contact is
-- referred to by id only (erasing the person anonymises the log, ADR 0001); the organisation is kept as it was then.
CREATE TABLE status_deliveries (
  id              bigserial PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('confirm', 'subscriber', 'contact')),
  update_id       int REFERENCES status_updates(id) ON DELETE CASCADE,
  subscriber_id   int REFERENCES status_subscribers(id) ON DELETE SET NULL,
  person_id       int REFERENCES people(id) ON DELETE SET NULL,
  organisation    text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  sent_at         timestamptz,
  error           text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'contact' OR update_id IS NOT NULL)
);
CREATE INDEX status_deliveries_due_idx ON status_deliveries (next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX status_deliveries_update_idx ON status_deliveries (update_id) WHERE update_id IS NOT NULL;

-- The log follows the update it belongs to, which follows its incident (122_status_page.sql).
ALTER TABLE status_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY status_deliveries_visible ON status_deliveries USING (update_id IS NULL OR EXISTS (SELECT 1 FROM status_updates su WHERE su.id = update_id));
