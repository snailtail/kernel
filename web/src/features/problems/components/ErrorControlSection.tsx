import { useState } from 'react';
import { api, type ProblemDetail } from '../../../api/client';
import { Markdown } from '../../../components/Markdown';
import { DECISION_LABEL, EFFECTIVENESS_LABEL, formatDay, relativeTime, RISK_LABEL } from '../../../format';
import { canEdit, useSession } from '../../../session';
import { AssessmentModal } from './AssessmentModal';
import '../styles.css';

export function ErrorControlSection({ problem: p, onChange }: { problem: ProblemDetail; onChange: (p: ProblemDetail) => void }) {
  const { user } = useSession();
  const [editing, setEditing] = useState(false);
  const editable = canEdit(user) && p.status !== 'closed';
  const decision = p.ec_decision ?? 'pending';
  const empty = !p.ec_risk && !p.ec_fix_cost && !p.ec_decision_note && !p.ec_risk_level && !p.workaround_effectiveness;
  const proposedEc = (p.mcp_proposed ?? []).filter((f) => f.startsWith('ec_'));
  const confirmEc = async () => onChange(await api.post<ProblemDetail>(`/api/problems/${p.ref}/confirm`, { fields: proposedEc }));
  return (
    <section className="card error-control">
      <div className="section-head">
        <h2>Error control {proposedEc.length > 0 && <span className="badge proposed-badge">Proposed via MCP</span>}</h2>
        <span className="section-actions">
          {proposedEc.length > 0 && editable && <button className="btn-link" onClick={confirmEc}>Confirm</button>}
          {editable && <button className="btn-link" onClick={() => setEditing(true)}>{empty ? 'Assess' : 'Edit'}</button>}
        </span>
      </div>
      <div className="ec-chips">
        <span className={`badge decision-${decision}`}>{DECISION_LABEL[decision]}</span>
        {p.ec_risk_level && <span className={`badge risk-${p.ec_risk_level}`}>{RISK_LABEL[p.ec_risk_level]}</span>}
        {p.workaround_effectiveness && <span className={`badge eff-${p.workaround_effectiveness}`}>{EFFECTIVENESS_LABEL[p.workaround_effectiveness]}</span>}
        {p.ec_review_date && (
          <span className={`badge ${p.ec_review_due ? 'major' : 'neutral'}`}>{p.ec_review_due ? 'Review overdue' : 'Review'} {formatDay(p.ec_review_date)}</span>
        )}
      </div>
      {empty ? (
        <p className="placeholder">Assess the risk of not fixing this known error against the cost of a permanent fix, and record the decision.</p>
      ) : (
        <dl className="ec-grid">
          {p.ec_risk && (<><dt>Risk of not fixing</dt><dd><Markdown text={p.ec_risk} /></dd></>)}
          {p.ec_fix_cost && (<><dt>Cost of fixing</dt><dd><Markdown text={p.ec_fix_cost} /></dd></>)}
          {p.ec_decision_note && (<><dt>Rationale</dt><dd><Markdown text={p.ec_decision_note} /></dd></>)}
        </dl>
      )}
      {p.ec_decided_by_name && p.ec_decided_at && (
        <p className="muted small">Decided by {p.ec_decided_by_name} {relativeTime(p.ec_decided_at)}{p.workaround_reviewed_at ? ` · workaround reviewed ${relativeTime(p.workaround_reviewed_at)}` : ''}</p>
      )}
      {editing && <AssessmentModal problem={p} onClose={() => setEditing(false)} onDone={(np) => { onChange(np); setEditing(false); }} />}
    </section>
  );
}
