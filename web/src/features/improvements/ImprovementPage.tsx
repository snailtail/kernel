import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../../api/client';
import { ActionsCard } from '../../components/Actions';
import { StatusBadge } from '../../components/Badges';
import { CommentBox } from '../../components/CommentBox';
import { GuidePanel } from '../../components/Guide';
import { HistoryPanel } from '../../components/History';
import { Markdown } from '../../components/Markdown';
import { Presence } from '../../components/Presence';
import { TransitionButtons } from '../../components/TransitionButtons';
import { RecordNotFound, VisibilityPanel } from '../../components/Visibility';
import { formatDate, relativeTime } from '../../format';
import { useRecord } from '../../hooks';
import { useLive } from '../../hooks/useLive';
import { canEdit, useSession } from '../../session';
import { IMPROVEMENT_STATUS, type ImprovementStatus } from '../../statuses';
import type { Improvement } from '../../api/types/improvements';
import { KPI_LABEL, quadrantOf, transitionBody, LINK_PATH } from './common';
import { EditImprovement } from './components/ImprovementForms';
import { LinksCard } from './components/LinksCard';
import { KpiCard } from './components/KpiCard';

const SOURCE: Record<string, string> = { review: 'Post-incident review', problem: 'Problem', service_review: 'Service review', idea: 'Idea', retrospective: 'Sprint retrospective' };
const TRANSITION_LABEL: Record<ImprovementStatus, string> = { idea: 'Back to idea', approved: 'Approve', in_progress: 'Start', done: 'Mark done', rejected: 'Reject' };
/** A move back is not a decision: "Back to approved" pauses work, "Reopen" picks done work up again. */
const transitionLabel = (from: ImprovementStatus, to: ImprovementStatus) => (from === 'in_progress' && to === 'approved' ? 'Back to approved' : from === 'done' && to === 'in_progress' ? 'Reopen' : TRANSITION_LABEL[to]);

export function ImprovementPage() {
  const { ref } = useParams();
  const { user } = useSession();
  const { data: m, setData, error, reload, refresh, actionError, setActionError, run } = useRecord<Improvement>(`/api/improvements/${ref}`);
  const others = useLive([m && `improvement:${m.id}`], refresh, { presence: true });
  const [editing, setEditing] = useState(false);
  if (error) return <RecordNotFound refId={ref ?? ''} error={error} onOpened={reload} />;
  if (!m) return null;
  const path = `/api/improvements/${m.ref}`;
  const editable = canEdit(user);
  const go = async (to: ImprovementStatus) => {
    const body = await transitionBody(to, m.benefit);
    if (body) await run(() => api.post(`${path}/transition`, body));
  };
  const sourcePath = m.source_ref ? (m.source === 'service_review' ? `/cis/${m.source_ref}` : LINK_PATH[{ PRB: 'problem', PIR: 'review', INC: 'incident', CHG: 'change' }[m.source_ref.slice(0, 3)] ?? 'document']?.(m.source_ref, {} as never)) : null;

  return (
    <>
      <header className="problem-head">
        <div className="crumbs"><Link to="/improvements">Improvements</Link> / <span className="mono">{m.ref}</span> <Presence people={others} /></div>
        <h1>{m.title}</h1>
        <div className="badges">
          <StatusBadge kind="improvement" status={m.status} />
          {quadrantOf(m) === 'quick' && <span className="tag quick-win">quick win</span>}
          <span className="tag">{SOURCE[m.source]}{m.source_ref && <> {sourcePath ? <Link to={sourcePath} className="mono">{m.source_ref}</Link> : <span className="mono">{m.source_ref}</span>}</>}</span>
          <span className="muted small">Suggested by {m.created_by_name ?? 'someone'} {relativeTime(m.created_at)}</span>
        </div>
        {editable && (
          <TransitionButtons buttons={[
            ...m.transitions.map((to) => ({
              label: transitionLabel(m.status, to),
              tone: to === 'rejected' ? 'danger' as const : to === m.transitions[0] && to !== 'idea' ? 'primary' as const : undefined,
              onClick: () => go(to),
            })),
            { label: 'Edit', onClick: () => setEditing(true) },
          ]} />
        )}
        {m.status === 'idea' && !m.may_decide && <p className="muted small">A manager approves or rejects it.</p>}
        {actionError && <div className="error">{actionError}</div>}
      </header>

      <div className="problem-grid">
        <div className="problem-main">
          <GuidePanel guidance={m.next_steps} />
          <section className="card"><h2>Where we are, and where we want to be</h2>{m.confidential_masked ? <p className="placeholder">Confidential.</p> : m.description ? <Markdown text={m.description} /> : <p className="placeholder">No description.</p>}</section>
          {(m.status === 'done' || m.benefit) && <section className="card"><h2>Benefit</h2>{m.benefit ? <Markdown text={m.benefit} /> : <p className="placeholder">Confidential.</p>}</section>}
          {m.status === 'rejected' && <section className="card"><h2>Why it was rejected</h2>{m.reject_reason ? <Markdown text={m.reject_reason} /> : <p className="placeholder">Confidential.</p>}{m.decided_by_name && <p className="muted small">{m.decided_by_name}, {m.decided_at && formatDate(m.decided_at)}</p>}</section>}
          <LinksCard m={m} editable={editable} onChange={run} />
          <ActionsCard parent={m.ref} actions={m.actions} editable={editable} onChanged={reload}
            placeholder="No follow-up actions. Add the steps that carry the improvement out, each with an owner and a date." />
          <section className="card">
            <h2>Notes &amp; history</h2>
            {editable && (
              <CommentBox recordRef={m.ref} placeholder="Add a note" onError={setActionError} onSubmit={(body) => run(() => api.post(`${path}/comments`, { body }))} />
            )}
            <ul className="activity">
              {m.activity.map((a) => (
                <li key={a.id}>
                  <div className="activity-head">
                    <strong>{a.user_name ?? 'System'}</strong>{' '}
                    {a.kind === 'comment' ? 'added a note' : a.kind === 'status' ? `moved it from ${IMPROVEMENT_STATUS[a.data.status?.from as ImprovementStatus] ?? '?'} to ${IMPROVEMENT_STATUS[a.data.status?.to as ImprovementStatus] ?? '?'}` : a.body}
                    {(a.channel === 'mcp' || a.channel === 'api') && <span className="tag channel">via {a.channel.toUpperCase()}</span>}
                    <time title={formatDate(a.created_at)}>{relativeTime(a.created_at)}</time>
                  </div>
                  {a.kind === 'comment' && a.body && <Markdown text={a.body} className="activity-body" />}
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside className="problem-side">
          <section className="card">
            <h2>Details</h2>
            <dl className="kv">
              <dt>Owner</dt><dd>{m.owner ?? '–'}</dd>
              <dt>Service</dt><dd>{m.service ? <Link to={`/cis/${m.service.ref}`}>{m.service.name}</Link> : '–'}</dd>
              <dt>Value</dt><dd>{m.value ?? '–'}</dd>
              <dt>Effort</dt><dd>{m.effort ?? '–'}</dd>
              <dt>Decided</dt><dd>{m.decided_at ? `${formatDate(m.decided_at)}${m.decided_by_name ? `, ${m.decided_by_name}` : ''}` : '–'}</dd>
              <dt>Done</dt><dd>{m.done_at ? formatDate(m.done_at) : '–'}</dd>
            </dl>
          </section>
          {m.kpi_tile ? <KpiCard tile={m.kpi_tile} /> : m.kpi && <section className="card"><h2>KPI</h2><p className="muted small">{KPI_LABEL[m.kpi] ?? m.kpi}: not shown (the practice is off, or your role cannot read reports).</p></section>}
          <VisibilityPanel record={{ ...m, assignee_id: m.owner_id }} onChange={reload} />
          <HistoryPanel recordRef={m.ref} version={m} />
        </aside>
      </div>
      {editing && <EditImprovement m={m} onClose={() => setEditing(false)} onDone={(next) => { setData(next); setEditing(false); }} />}
    </>
  );
}
