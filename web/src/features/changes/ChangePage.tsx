import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../../api/client';
import { AffectedCisPanel } from '../../components/AffectedCis';
import { PersonalDataBadge, StatusBadge } from '../../components/Badges';
import { CommentBox } from '../../components/CommentBox';
import { GuidePanel } from '../../components/Guide';
import { Markdown } from '../../components/Markdown';
import { TransitionButtons } from '../../components/TransitionButtons';
import { RecordNotFound, VisibilityPanel } from '../../components/Visibility';
import { DevLinksPanel } from '../../components/DevLinks';
import { SummaryButton } from '../../components/Ai';
import { AttachmentsPanel } from '../../components/Attachments';
import { formatDate, relativeTime } from '../../format';
import { useLive } from '../../hooks/useLive';
import { Presence } from '../../components/Presence';
import { useRecord } from '../../hooks';
import { useSession } from '../../session';
import { HistoryPanel } from '../../components/History';
import { TraceCard } from '../../components/Trace';
import { CHANGE_STATUS, type ChangeStatus } from '../../statuses';
import type { Change } from '../../api/types/changes';
import { OUTCOME, fmtWindow } from './common';
import { FinishChange } from './components/FinishChange';
import { DeliversCard } from './components/DeliversCard';
import { EditChange } from './components/EditChange';

export function ChangePage() {
  const { ref } = useParams();
  const { user } = useSession();
  const { data: c, setData, error, reload, refresh, actionError, setActionError, run } = useRecord<Change>(`/api/changes/${ref}`);
  const others = useLive([c && `change:${c.id}`], refresh, { presence: true });
  const [editing, setEditing] = useState(false);
  const [finishing, setFinishing] = useState<null | 'review' | 'closed'>(null);
  if (error) return <RecordNotFound refId={ref ?? ''} error={error} onOpened={reload} />;
  if (!c) return null;
  const path = `/api/changes/${c.ref}`;
  const editable = user.role !== 'viewer' && !['closed', 'rejected', 'cancelled'].includes(c.status);
  const draftish = ['draft', 'assess'].includes(c.status);
  const go = (body: object) => run(() => api.post(`${path}/transition`, body));
  const vote = async (decision: 'approve' | 'reject') => {
    const comment = window.prompt(decision === 'approve' ? 'Comment (optional)' : 'Why is it rejected?') ?? '';
    if (decision === 'reject' && !comment.trim()) return;
    await run(() => api.post(`${path}/votes`, { decision, comment }));
  };
  const resolveProblem = async () => {
    await api.post(`/api/problems/${c.problem_ref}/transition`, { to: 'resolved', resolution: `Fixed by change ${c.ref}: ${c.title}` }).catch((err) => setActionError(err.message));
    setData(await api.get(path));
  };

  return (
    <>
      <header className="problem-head">
        <div className="crumbs"><Link to="/changes">Changes</Link> / <span className="mono">{c.ref}</span> <Presence people={others} /></div>
        <h1>{c.title}</h1>
        <div className="badges">
          {c.contains_personal_data && <PersonalDataBadge />}
          <StatusBadge kind="change" status={c.status} />
          <span className={`tag type-${c.change_type}`}>{c.change_type}{c.template && `: ${c.template}`}</span>
          <span className={`badge risk-${c.risk}`} title={c.risk_reason}>{c.risk} risk{c.risk_overridden && ` (assessed ${c.risk_assessed})`}</span>
          {c.outcome && <span className={`badge outcome-${c.outcome}`}>{OUTCOME[c.outcome]}</span>}
          <span className="muted small">Requested by {c.requested_by ?? c.source} {relativeTime(c.created_at)}</span>
        </div>
        {editable && (
          <TransitionButtons buttons={[
            { label: 'Submit for assessment', tone: 'primary', show: c.status === 'draft' && c.change_type !== 'standard', onClick: () => go({ to: 'assess' }) },
            { label: 'Schedule', tone: 'primary', show: c.status === 'draft' && c.change_type === 'standard', onClick: () => go({ to: 'scheduled' }) },
            { label: 'Submit for authorisation', tone: 'primary', show: c.status === 'assess', onClick: () => go({ to: 'authorize' }) },
            {
              label: 'Start implementing', tone: 'primary',
              show: c.status === 'scheduled' || (c.status === 'authorize' && c.change_type === 'emergency' && c.approvals.approved >= c.approvals.required),
              onClick: () => go({ to: 'implementing' }),
            },
            { label: 'Record outcome', tone: 'primary', show: c.status === 'implementing', onClick: () => setFinishing('review') },
            { label: 'Close', tone: 'primary', show: c.status === 'review', onClick: () => setFinishing('closed') },
            { label: 'Rework', show: c.status === 'rejected', onClick: () => go({ to: 'draft' }) },
            { label: 'Edit', show: draftish, onClick: () => setEditing(true) },
            {
              label: 'Cancel change', show: ['draft', 'assess', 'authorize', 'scheduled'].includes(c.status),
              onClick: () => { const r = window.prompt('Why is the change cancelled?'); if (r?.trim()) go({ to: 'cancelled', cancel_reason: r.trim() }); },
            },
          ]} />
        )}
        {actionError && <div className="error">{actionError}</div>}
      </header>

      {(c.collisions.length > 0 || c.freezes.length > 0) && !['closed', 'cancelled', 'rejected'].includes(c.status) && (
        <div className="warn-box">
          {c.freezes.map((f) => <div key={f.name}>The window overlaps the change freeze <strong>{f.name}</strong> ({formatDate(f.starts_at)} – {formatDate(f.ends_at)}).</div>)}
          {c.collisions.map((x) => <div key={x.ref + x.ci}>Collides with <Link to={`/changes/${x.ref}`}>{x.ref}</Link> {x.title} on {x.ci} ({fmtWindow(x.planned_start, x.planned_end)}).</div>)}
        </div>
      )}
      {c.status === 'closed' && c.outcome === 'successful' && c.problem_ref && !['resolved', 'closed'].includes(c.problem_status ?? '') && (
        <div className="hint-box hint-row">The change fixed problem <Link to={`/problems/${c.problem_ref}`}>{c.problem_ref}</Link>. <button className="btn small" onClick={resolveProblem}>Resolve the problem</button></div>
      )}

      <div className="problem-grid">
        <div className="problem-main">
          <GuidePanel guidance={c.next_steps} onHandover={(h) => { if (h.action === 'resolve_problem') resolveProblem(); }} />
          {c.status === 'authorize' && (
            <section className="card approvals-card">
              <h2>Authorisation <span className="count">{c.approvals.approved} of {c.approvals.required}</span></h2>
              <p className="muted small">{c.risk} risk: {c.risk_reason}. The requester cannot approve their own change.</p>
              <ul className="plain-list">{c.votes.map((v) => <li key={v.approver}><strong>{v.approver}</strong> {v.decision === 'approve' ? 'approved' : 'rejected'} {relativeTime(v.created_at)}{v.comment && `: ${v.comment}`}</li>)}</ul>
              {c.can_vote && <div className="actions"><button className="btn danger" onClick={() => vote('reject')}>Reject</button><button className="btn primary" onClick={() => vote('approve')}>Approve</button></div>}
            </section>
          )}
          <section className="card"><h2>Description</h2>{c.description ? <Markdown text={c.description} /> : <p className="placeholder">No description.</p>}</section>
          <section className="card plans">
            <h2>Plans</h2>
            <h3>Implementation</h3>{c.implementation_plan ? <Markdown text={c.implementation_plan} /> : <p className="placeholder">Not written.</p>}
            <h3>Test</h3>{c.test_plan ? <Markdown text={c.test_plan} /> : <p className="placeholder">Not written.</p>}
            <h3>Backout</h3>{c.backout_plan ? <Markdown text={c.backout_plan} /> : <p className="placeholder">Not written.</p>}
          </section>
          {c.review && <section className="card"><h2>Post-implementation review</h2><Markdown text={c.review} /></section>}
          <TraceCard recordRef={c.ref} version={c} />
          <section className="card">
            <h2>Notes &amp; history</h2>
            {editable && (
              <CommentBox recordRef={c.ref} placeholder="Add a note – paste screenshots and logs here" onError={setActionError} onSubmit={(body) => run(() => api.post(`${path}/comments`, { body }))} />
            )}
            <ul className="activity">
              {c.activity.map((a) => (
                <li key={a.id}>
                  <div className="activity-head">
                    <strong>{a.user_name ?? 'System'}</strong>{' '}
                    {a.kind === 'comment' ? 'added a note' : a.kind === 'status' ? `moved it from ${CHANGE_STATUS[a.data.from as ChangeStatus]} to ${CHANGE_STATUS[a.data.to as ChangeStatus]}` : a.kind === 'vote' ? (a.data.decision === 'approve' ? 'approved' : 'rejected') : a.body}
                    {(a.channel === 'mcp' || a.channel === 'api') && <span className="tag channel">via {a.channel.toUpperCase()}</span>}
                    {(a.channel === 'email_link' || a.channel === 'chat_link') && <span className="tag channel" title="Decided from the approval link in a notification">via {a.channel === 'email_link' ? 'email' : 'chat'} link</span>}
                    <time title={formatDate(a.created_at)}>{relativeTime(a.created_at)}</time>
                  </div>
                  {(a.kind === 'comment' || ((a.kind === 'status' || a.kind === 'vote') && a.body)) && <Markdown text={a.body} className="activity-body" />}
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside className="problem-side">
          <SummaryButton recordRef={c.ref} onAddNote={async (body) => { await api.post(`/api/changes/${c.ref}/comments`, { body }); reload(); }} />
          <VisibilityPanel record={c} onChange={reload} />
          <DevLinksPanel recordRef={c.ref} editable={editable} />
          <AttachmentsPanel recordRef={c.ref} editable={editable} canDelete={(a) => a.uploaded_by === user.id || user.role === 'admin' || user.role === 'manager'} />
          <HistoryPanel recordRef={c.ref} version={c} />
          <section className="card">
            <h2>Window</h2>
            <dl className="kv">
              <dt>Planned</dt><dd>{fmtWindow(c.planned_start, c.planned_end)}</dd>
              <dt>Started</dt><dd>{c.actual_start ? formatDate(c.actual_start) : '–'}</dd>
              <dt>Finished</dt><dd>{c.actual_end ? formatDate(c.actual_end) : '–'}</dd>
              <dt>Assignee</dt><dd>{c.assignee ?? '–'}</dd>
            </dl>
          </section>
          <AffectedCisPanel record={{ ...c, impact_hint: null, impact_incomplete: false }} basePath={path} editable={editable && draftish} onChange={(n) => setData(n as Change)} />
          {c.problem_ref && <section className="card"><h2>Fixes problem</h2><p><Link to={`/problems/${c.problem_ref}`} className="mono">{c.problem_ref}</Link> {c.problem_title} <span className="muted small">{c.problem_status?.replace('_', ' ')}</span></p></section>}
          {c.work_items && <DeliversCard change={c} editable={user.role !== 'viewer' && !['rejected', 'cancelled'].includes(c.status)} onChange={reload} />}
          {c.related_incidents.length > 0 && (
            <section className="card">
              <h2>Incidents after this change</h2>
              <p className="muted small">On its CIs or on what depends on them, shortly after it started.</p>
              <ul className="plain-list">{c.related_incidents.map((i) => <li key={i.ref}><Link to={`/incidents/${i.ref}`} className="mono">{i.ref}</Link> {i.title} <span className="muted small">{relativeTime(i.created_at)}</span></li>)}</ul>
            </section>
          )}
          {c.links.length > 0 && (
            <section className="card"><h2>Linked</h2><ul className="plain-list">{c.links.map((l) => <li key={l.id}><span className="tag">{l.kind.replace('_', ' ')}</span> {l.url ? <a href={l.url} target="_blank" rel="noreferrer noopener">{l.reference} ↗</a> : l.reference}</li>)}</ul></section>
          )}
        </aside>
      </div>
      {editing && <EditChange change={c} onClose={() => setEditing(false)} onDone={(n) => { setData(n); setEditing(false); }} />}
      {finishing && <FinishChange change={c} to={finishing} onClose={() => setFinishing(null)} onDone={(n) => { setData(n); setFinishing(null); }} />}
    </>
  );
}
