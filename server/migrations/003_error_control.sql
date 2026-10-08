-- Error control assessment of known errors: risk, cost of fixing, and the fix/accept decision.
ALTER TABLE problems
  ADD COLUMN ec_risk_level smallint CHECK (ec_risk_level BETWEEN 1 AND 3),
  ADD COLUMN ec_risk text NOT NULL DEFAULT '',
  ADD COLUMN ec_fix_cost text NOT NULL DEFAULT '',
  ADD COLUMN ec_decision text CHECK (ec_decision IN ('pending', 'fix', 'accept', 'defer')),
  ADD COLUMN ec_decision_note text NOT NULL DEFAULT '',
  ADD COLUMN ec_decided_by int REFERENCES users(id),
  ADD COLUMN ec_decided_at timestamptz,
  ADD COLUMN ec_review_date date,
  ADD COLUMN workaround_effectiveness text CHECK (workaround_effectiveness IN ('effective', 'partial', 'ineffective')),
  ADD COLUMN workaround_reviewed_at timestamptz;
CREATE INDEX problems_ec_review_idx ON problems (ec_review_date) WHERE status = 'known_error';
