-- Bulk at scale (#125). The pages of one bulk request share a dedup key ("bulk:<request id>"): the first trigger per
-- target is sent as a summary of all the incidents, the others are recorded as skipped under the same key, and
-- acknowledging or resolving the summary in the paging tool reaches every incident it covers.
ALTER TABLE pages ADD COLUMN dedup_key text;
CREATE INDEX pages_dedup_idx ON pages (target_id, dedup_key) WHERE dedup_key IS NOT NULL;

-- What a bulk request changed, so a summary notification can link to a list of just those records. Refs only: the
-- lists filter them through row-level security like any other filter. Kept as long as the notifications.
CREATE TABLE bulk_requests (
  id         uuid PRIMARY KEY,
  practice   text NOT NULL,
  user_id    int REFERENCES users(id) ON DELETE SET NULL,
  refs       text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
