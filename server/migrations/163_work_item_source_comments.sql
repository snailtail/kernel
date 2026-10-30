-- Mirrored backlogs (#168), part 2: GitHub and GitLab beside Azure DevOps, and a comment back to the source when a
-- mirrored item is linked to a Kernel record ("Linked to PRB000123 in Kernel"). Only that comment goes back, never a
-- status change; a mirror can turn it off.

ALTER TABLE work_item_mirrors ADD COLUMN comment_links boolean NOT NULL DEFAULT true;

-- The comments to post, through the shared outbox (core/outbox.ts). One per item and Kernel record, ever: a link that
-- is removed and made again is not announced twice.
CREATE TABLE work_item_source_comments (
  id              serial PRIMARY KEY,
  work_item_id    int NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  reference       text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  error           text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_item_id, reference)
);
CREATE INDEX work_item_source_comments_due_idx ON work_item_source_comments (next_attempt_at) WHERE status IN ('pending', 'sending');

-- Visibility (#53) as the item's links: only for those who see the item and the Kernel record.
ALTER TABLE work_item_source_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_source_comments FORCE ROW LEVEL SECURITY;
CREATE POLICY work_item_source_comments_visible ON work_item_source_comments USING (
  EXISTS (SELECT 1 FROM work_items w WHERE w.id = work_item_id) AND NOT kernel_ref_hidden(reference));
