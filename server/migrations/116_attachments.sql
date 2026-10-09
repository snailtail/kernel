-- Attachments on records (#51, #74). Stored in PostgreSQL, so they are in every backup, deleted with their record and
-- covered by the same access rules. Images are re-encoded on upload (metadata such as GPS removed) and get a preview
-- and a thumbnail; the client's bytes are never served back unchanged.
CREATE TABLE attachments (
  id           serial PRIMARY KEY,
  record_type  text NOT NULL,
  record_ref   text NOT NULL,
  filename     text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('image', 'pdf', 'text', 'file')),
  content_type text NOT NULL,
  size         int NOT NULL,
  sha256       text NOT NULL,
  width        int,
  height       int,
  flags        text[] NOT NULL DEFAULT '{}',
  uploaded_by  int REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_record_idx ON attachments (record_type, record_ref);

-- Bytes apart from the metadata, so lists never read them.
CREATE TABLE attachment_blobs (
  attachment_id int NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  variant       text NOT NULL CHECK (variant IN ('original', 'preview', 'thumb')),
  content_type  text NOT NULL,
  data          bytea NOT NULL,
  PRIMARY KEY (attachment_id, variant)
);
ALTER TABLE attachment_blobs ALTER COLUMN data SET STORAGE EXTERNAL; -- already compressed formats: skip TOAST compression

-- When a record is deleted (demo data, retention), its attachments go with it.
CREATE FUNCTION kernel_delete_attachments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM attachments WHERE record_type = TG_ARGV[0] AND record_ref = OLD.ref;
  RETURN OLD;
END $$;
CREATE TRIGGER problems_attachments AFTER DELETE ON problems FOR EACH ROW EXECUTE FUNCTION kernel_delete_attachments('problem');
CREATE TRIGGER incidents_attachments AFTER DELETE ON incidents FOR EACH ROW EXECUTE FUNCTION kernel_delete_attachments('incident');
CREATE TRIGGER changes_attachments AFTER DELETE ON changes FOR EACH ROW EXECUTE FUNCTION kernel_delete_attachments('change');
CREATE FUNCTION kernel_delete_ci_attachments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM attachments WHERE record_type = OLD.class AND record_ref = OLD.ref; -- 'ci' or 'service'
  RETURN OLD;
END $$;
CREATE TRIGGER cis_attachments AFTER DELETE ON configuration_items FOR EACH ROW EXECUTE FUNCTION kernel_delete_ci_attachments();

INSERT INTO settings (key, value) VALUES ('attachments', '{"max_file_mb": 10, "max_per_record": 100, "max_total_gb": 10}') ON CONFLICT (key) DO NOTHING;

-- What attachments may be sent to an AI provider through MCP. Off by default: screenshots often show names and data,
-- and flagged text may hold secrets. Administrators decide (Administration → Security status).
INSERT INTO settings (key, value) VALUES ('ai_data', '{"attachment_images": false, "flagged_text": false}') ON CONFLICT (key) DO NOTHING;
