-- Approvals are claimed atomically ('processing') and expire after 14 days.
ALTER TABLE pending_approvals DROP CONSTRAINT pending_approvals_status_check;
ALTER TABLE pending_approvals ADD CONSTRAINT pending_approvals_status_check
  CHECK (status IN ('pending', 'processing', 'approved', 'rejected', 'failed', 'expired'));
