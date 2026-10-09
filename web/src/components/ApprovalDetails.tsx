import { CLOSURE_LABEL, DECISION_LABEL, EFFECTIVENESS_LABEL, RISK_LABEL } from '../format';
import { Markdown } from './Markdown';

const LABELS: Record<string, string> = {
  closure_code: 'Closure code', comment: 'Comment', of: 'Duplicate of',
  ec_decision: 'Decision', ec_risk_level: 'Risk of not fixing', ec_risk: 'Risk', ec_fix_cost: 'Cost of fixing',
  ec_decision_note: 'Rationale', ec_review_date: 'Review date', workaround_effectiveness: 'Workaround',
  root_cause: 'Root cause', workaround: 'Workaround text', resolution: 'Resolution', major_review: 'Major problem review',
  acknowledge_open_actions: 'Close with open actions',
};

const display = (k: string, v: unknown) => {
  if (k === 'closure_code') return CLOSURE_LABEL[String(v)] ?? String(v);
  if (k === 'ec_decision') return DECISION_LABEL[String(v)] ?? String(v);
  if (k === 'ec_risk_level') return RISK_LABEL[Number(v)] ?? String(v);
  if (k === 'workaround_effectiveness') return EFFECTIVENESS_LABEL[String(v)] ?? String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
};

/** Everything an approval will write, so the approver sees the agent's text before approving. */
export function ApprovalDetails({ payload, changedSince }: { payload: Record<string, unknown>; changedSince?: boolean }) {
  const entries = Object.entries(payload ?? {}).filter(([k, v]) => k !== 'to' && v !== null && v !== undefined && v !== '');
  return (
    <div className="approval-details">
      {changedSince && <p className="warn-box">The problem has changed since this was requested. Check it is still right.</p>}
      {entries.length > 0 && (
        <dl>
          {entries.map(([k, v]) => (
            <div key={k}>
              <dt>{LABELS[k] ?? k}</dt>
              <dd>{typeof v === 'string' && v.length > 60 ? <Markdown text={v} /> : display(k, v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="muted small">Text written by the agent will be stored as shown when you approve.</p>
    </div>
  );
}
