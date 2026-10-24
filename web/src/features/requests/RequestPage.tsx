import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../../api/client';
import { askReason } from '../../components/Ask';
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
import type { RequestDetail, Clock } from '../../api/types/requests';
import { TaskList } from './components/TaskList';

// ---- One request ---------------------------------------------------------------------------

function clockLabel(c: Clock, paused: boolean) {
  if (c.state === 'none') return '–';
  if (c.state === 'met') return 'Met';
  if (c.state === 'breached') return 'Breached';
  if (paused) return 'Paused (waiting for approval)';
  const m = c.remaining_minutes ?? 0;
  return `${m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`} left${c.state === 'at_risk' ? ' (at risk)' : ''}`;
}

export function RequestPage() {
  const { ref } = useParams();
  const { user } = useSession();
  const { data: r, error, reload, refresh, actionError, setActionError, run } = useRecord<RequestDetail>(`/api/requests/${ref}`);
  const others = useLive([r && `request:${r.id}`], refresh, { presence: true });
  // A note is internal unless the person chooses to reply to the requester (#45): replies show in the portal and go by mail.
  const [toRequester, setToRequester] = useState(false);
  if (error) return <RecordNotFound refId={ref ?? ''} error={error} onOpened={reload} />;
  if (!r) return null;
  const path = `/api/requests/${r.ref}`;
  const editable = canEdit(user);
  const decide = async (decision: 'approve' | 'reject') => {
    const comment = decision === 'reject'
      ? await askReason(`Reject ${r.ref}`, 'Say why, so the requester knows what to do instead.', { confirmLabel: 'Reject', danger: true })
      : '';
    if (comment === null) return;
    await run(() => api.post(`${path}/approval`, { decision, comment }));
  };
  const cancel = async () => {
    const reason = await askReason(`Cancel ${r.ref}`, 'Say why it is no longer needed. Open tasks are cancelled with it.', { confirmLabel: 'Cancel request', danger: true });
    if (reason) await run(() => api.post(`${path}/transition`, { to: 'cancelled', reason }));
  };

  return (
    <>
      <header className="problem-head">
        <div className="crumbs"><Link to="/requests">Service requests</Link> / <span className="mono">{r.ref}</span> <Presence people={others} /></div>
        <h1>{r.title}</h1>
        <div className="badges">
          <StatusBadge kind="request" status={r.status} />
          <span className="tag">{r.item.name}</span>
          <span className="muted small">For {r.requester.name}{r.on_behalf_of ? `, logged by ${r.on_behalf_of}` : ''} {relativeTime(r.created_at)}</span>
        </div>
        <TransitionButtons buttons={[
          { label: 'Approve', tone: 'primary', show: r.approval.may_decide, onClick: () => decide('approve') },
          { label: 'Reject', tone: 'danger', show: r.approval.may_decide, onClick: () => decide('reject') },
          { label: 'Cancel request', show: editable && r.transitions.includes('cancelled'), onClick: cancel },
        ]} />
        {r.status === 'awaiting_approval' && !r.approval.may_decide && <p className="muted small">Waiting for {r.approval.approvers.join(' or ')} to approve.</p>}
        {actionError && <div className="error">{actionError}</div>}
      </header>

      <div className="problem-grid">
        <div className="problem-main">
          <GuidePanel guidance={r.next_steps} />
          <section className="card">
            <h2>What was asked</h2>
            {r.answers.length === 0 ? <p className="placeholder">This item has no form.</p> : (
              <dl className="kv answers">
                {r.answers.map((a) => (
                  <div key={a.key} className="kv-row">
                    <dt>{a.label}</dt>
                    <dd>
                      {a.type === 'text' || a.type === 'textarea'
                        ? a.answer_text ? <Markdown text={a.answer_text} /> : r.confidential_masked ? <span className="placeholder">Confidential.</span> : <span className="muted">–</span>
                        : a.type === 'ci' && a.value ? <Link to={`/cis/${a.value}`} className="mono">{a.display ?? a.value}</Link>
                        : a.type === 'person' && a.value ? a.display
                        : a.value ?? <span className="muted">–</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <section className="card">
            <h2>Fulfilment <span className="count">{r.tasks.filter((t) => t.status === 'done').length} / {r.tasks.length}</span></h2>
            <TaskList r={r} onRun={run} />
          </section>
          {r.status === 'rejected' && <section className="card"><h2>Why it was rejected</h2>{r.approval.reject_reason ? <Markdown text={r.approval.reject_reason} /> : <p className="placeholder">Confidential.</p>}</section>}
          {r.status === 'cancelled' && <section className="card"><h2>Why it was cancelled</h2>{r.cancel_reason ? <Markdown text={r.cancel_reason} /> : <p className="placeholder">Confidential.</p>}</section>}
          <section className="card">
            <h2>Notes &amp; history</h2>
            {editable && (
              <CommentBox recordRef={r.ref} paste={false} placeholder={toRequester ? `Reply to ${r.requester.name}: they see it in the portal and by email` : 'Add a note'}
                submitLabel={toRequester ? 'Send reply' : 'Add note'} audience={{ name: r.requester.name, reply: toRequester, onReply: setToRequester }} onError={setActionError}
                onSubmit={async (body) => { const ok = await run(() => api.post(`${path}/comments`, { body, to_requester: toRequester })); if (ok) setToRequester(false); return ok; }} />
            )}
            <ul className="activity">
              {r.activity.map((a) => (
                <li key={a.id}>
                  <div className="activity-head">
                    <strong>{a.data?.from_requester ? `${r.requester.name} (portal)` : a.user_name ?? 'System'}</strong>{' '}
                    {a.kind === 'comment' ? (a.data?.from_requester ? 'added information' : a.data?.for_requester ? 'replied to the requester' : 'added a note') : a.body}
                    {a.data?.for_requester && <span className="tag reply">Sent to the requester</span>}
                    {(a.channel === 'mcp' || a.channel === 'api' || a.channel.endsWith('_link')) && <span className="tag channel">via {a.channel.replace('_link', ' link').toUpperCase()}</span>}
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
              <dt>For</dt><dd>{r.requester.name}{r.requester.email && <div className="muted small">{r.requester.email}</div>}</dd>
              <dt>Service</dt><dd><Link to={`/cis/${r.service.ref}`}>{r.service.name}</Link></dd>
              <dt>Priority</dt><dd>P{r.priority}</dd>
              <dt>Approval</dt><dd>{r.approval.kind === 'none' ? 'Not needed' : r.approval.decided_at ? `${r.approval.decided_by ?? 'Someone'}, ${formatDate(r.approval.decided_at)}` : r.approval.approvers.join(', ')}</dd>
              {r.sla && <><dt>SLA</dt><dd>{r.sla.name}<div className="muted small">{clockLabel(r.sla.resolution, r.sla.paused)}</div></dd></>}
              <dt>Done</dt><dd>{r.resolved_at ? formatDate(r.resolved_at) : '–'}</dd>
            </dl>
          </section>
          <VisibilityPanel record={{ ...r, assignee_id: null }} onChange={reload} />
          <HistoryPanel recordRef={r.ref} version={r} />
        </aside>
      </div>
    </>
  );
}
