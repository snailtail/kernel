import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
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
import { WORK_ITEM_STATUS, type WorkItemStatus } from '../../statuses';
import type { Criterion, WorkItem } from '../../api/types/development';
import { DefinitionCheck, ProgressBar, useParentTypes, transitionLabel, TYPE_LABEL, TypeBadge } from './common';
import { EditWorkItem, NewWorkItem } from './components/WorkItemForms';
import './styles.css';

const PRIMARY: Partial<Record<WorkItemStatus, WorkItemStatus>> = { new: 'ready', ready: 'in_progress', in_progress: 'in_review', in_review: 'done' };

export function WorkItemPage() {
  const { ref } = useParams();
  const { user } = useSession();
  const navigate = useNavigate();
  const { data: w, setData, error, reload, refresh, actionError, setActionError, run } = useRecord<WorkItem>(`/api/work-items/${ref}`);
  const others = useLive([w && `work_item:${w.id}`], refresh, { presence: true });
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState<'ready' | 'done' | null>(null);
  const parentTypes = useParentTypes();
  if (error) return <RecordNotFound refId={ref ?? ''} error={error} onOpened={reload} />;
  if (!w) return null;
  const path = `/api/work-items/${w.ref}`;
  const editable = canEdit(user);
  const masked = !!w.confidential_masked;
  const go = async (to: WorkItemStatus) => {
    if ((to === 'ready' || to === 'done') && w.definitions[to].length) return setChecking(to);
    if (to === 'removed') {
      const reason = await askReason(`Remove ${w.ref} from the backlog`, 'Say why, so it is not lost and can come back.', { confirmLabel: 'Remove', danger: true });
      if (reason) await run(() => api.post(`${path}/transition`, { to, reason }));
      return;
    }
    await run(() => api.post(`${path}/transition`, { to }));
  };
  const setCriteria = (next: Criterion[]) => run(() => api.patch(path, { acceptance_criteria: next }));

  return (
    <>
      <header className="problem-head">
        <div className="crumbs">
          <Link to={`/work${w.team_id ? `?team=${w.team_id}` : '?team=none'}`}>{w.team ? `${w.team} backlog` : 'Backlog'}</Link>
          {w.parent && <> / <Link to={`/work/${w.parent.ref}`} className="mono">{w.parent.ref}</Link></>} / <span className="mono">{w.ref}</span> <Presence people={others} />
        </div>
        <h1>{w.title}</h1>
        <div className="badges">
          <TypeBadge type={w.item_type} />
          <StatusBadge kind="work_item" status={w.status} />
          {w.points !== null && <span className="tag">{w.points} {w.points === 1 ? 'point' : 'points'}</span>}
          {w.sprint && <Link to={`/sprints/${w.sprint.id}`} className="tag">{w.sprint.status === 'completed' ? `Done in ${w.sprint.name}` : w.sprint.name}</Link>}
          {w.labels.map((l) => <Link key={l} to={`/work?team=${w.team_id ?? 'none'}&label=${encodeURIComponent(l)}`} className="tag">{l}</Link>)}
          <span className="muted small">Added by {w.created_by_name ?? 'someone'} {relativeTime(w.created_at)}</span>
        </div>
        {editable && (
          <TransitionButtons buttons={[
            ...w.transitions.map((to) => ({
              label: transitionLabel(w.status, to),
              tone: to === 'removed' ? 'danger' as const : to === PRIMARY[w.status] ? 'primary' as const : undefined,
              onClick: () => go(to),
            })),
            { label: 'Edit', onClick: () => setEditing(true) },
          ]} />
        )}
        {actionError && <div className="error">{actionError}</div>}
      </header>

      <div className="problem-grid">
        <div className="problem-main">
          <GuidePanel guidance={w.next_steps} />
          {w.item_type === 'bug' ? (
            <section className="card wi-bug">
              <h2>Bug report</h2>
              {masked ? <p className="placeholder">Confidential.</p> : (
                <div className="wi-report">
                  <div className="wi-report-wide"><h3>Steps to reproduce</h3>{w.steps_to_reproduce ? <Markdown text={w.steps_to_reproduce} /> : <p className="placeholder">Not written yet.</p>}</div>
                  <div><h3>Expected</h3><p>{w.expected_result || '–'}</p></div>
                  <div><h3>What happened</h3><p>{w.actual_result || '–'}</p></div>
                  <div className="wi-report-wide"><h3>Found in</h3><p>{w.found_in || '–'}</p></div>
                </div>
              )}
              {!masked && w.description && <Markdown text={w.description} />}
            </section>
          ) : (
            <section className="card"><h2>Description</h2>{masked ? <p className="placeholder">Confidential.</p> : w.description ? <Markdown text={w.description} /> : <p className="placeholder">No description.</p>}</section>
          )}
          {w.item_type !== 'epic' && <CriteriaCard criteria={w.acceptance_criteria} editable={editable && !masked} onChange={setCriteria} />}
          {(w.children.length > 0 || parentTypes.task.includes(w.item_type) || w.item_type === 'epic') && (
            <section className="card">
              <h2>{w.item_type === 'epic' ? 'Stories and bugs' : 'Tasks'} <span className="count">{w.children.length}</span> {w.progress && <ProgressBar p={w.progress} />}</h2>
              {w.children.length === 0 && <p className="placeholder">{w.item_type === 'epic' ? 'Split it into stories small enough for a sprint each.' : 'Break it into tasks if that helps the team.'}</p>}
              <ul className="plain-list">
                {w.children.map((c) => (
                  <li key={c.ref}>
                    <TypeBadge type={c.type} /> <Link to={`/work/${c.ref}`} className="mono">{c.ref}</Link> {c.title}{' '}
                    <StatusBadge kind="work_item" status={c.status} /> {c.points !== null && <span className="muted small">{c.points} pts</span>} {c.assignee && <span className="muted small">· {c.assignee}</span>}
                  </li>
                ))}
              </ul>
              {editable && <button className="btn small" onClick={() => setAdding(true)}>Add {w.item_type === 'epic' ? 'a story or bug' : 'a task'}</button>}
            </section>
          )}
          <LinksCard w={w} editable={editable} onChange={run} />
          <section className="card">
            <h2>Notes &amp; history</h2>
            {editable && <CommentBox recordRef={w.ref} placeholder="Add a note" onError={setActionError} onSubmit={(body) => run(() => api.post(`${path}/comments`, { body }))} />}
            <ul className="activity">
              {w.activity.map((a) => (
                <li key={a.id}>
                  <div className="activity-head">
                    <strong>{a.user_name ?? 'System'}</strong>{' '}
                    {a.kind === 'comment' ? 'added a note'
                      : a.kind === 'status' ? <>moved it from {WORK_ITEM_STATUS[a.data.status?.from as WorkItemStatus] ?? '?'} to {WORK_ITEM_STATUS[a.data.status?.to as WorkItemStatus] ?? '?'}{a.data.skipped?.length ? <span className="tag wi-skipped" title={a.data.skipped.join('; ')}>{a.data.definition} skipped: {a.data.skipped.length}</span> : null}</>
                      : a.body}
                    {(a.channel === 'mcp' || a.channel === 'api') && <span className="tag channel">via {a.channel.toUpperCase()}</span>}
                    <time title={formatDate(a.created_at)}>{relativeTime(a.created_at)}</time>
                  </div>
                  {a.kind === 'comment' && a.body && <Markdown text={a.body} className="activity-body" />}
                  {a.kind === 'status' && a.data.skipped?.length > 0 && <p className="muted small">Not confirmed: {a.data.skipped.join('; ')}</p>}
                  {a.kind === 'status' && a.data.reason && <p className="muted small">{a.data.reason}</p>}
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside className="problem-side">
          <section className="card">
            <h2>Details</h2>
            <dl className="kv">
              <dt>Type</dt><dd>{TYPE_LABEL[w.item_type]}</dd>
              <dt>Team</dt><dd>{w.team ?? '–'}</dd>
              <dt>Assignee</dt><dd>{w.assignee ?? '–'}</dd>
              <dt>Points</dt><dd>{w.points ?? 'Not estimated'}</dd>
              <dt>Under</dt><dd>{w.parent ? <Link to={`/work/${w.parent.ref}`}>{w.parent.title}</Link> : '–'}</dd>
              <dt>Started</dt><dd>{w.started_at ? formatDate(w.started_at) : '–'}</dd>
              <dt>Done</dt><dd>{w.done_at ? formatDate(w.done_at) : '–'}</dd>
            </dl>
          </section>
          {w.status === 'removed' && <section className="card"><h2>Why it was removed</h2>{w.remove_reason ? <p>{w.remove_reason}</p> : <p className="placeholder">Confidential.</p>}</section>}
          <VisibilityPanel record={w} onChange={reload} />
          <HistoryPanel recordRef={w.ref} version={w} />
        </aside>
      </div>
      {editing && <EditWorkItem w={w} onClose={() => setEditing(false)} onDone={(next) => { setData(next); setEditing(false); }} />}
      {adding && <NewWorkItem parent={{ ref: w.ref, type: w.item_type }} team={w.team_id ? String(w.team_id) : undefined} onClose={() => setAdding(false)} onDone={(r) => navigate(`/work/${r}`)} />}
      {checking && (
        <DefinitionCheck to={checking} items={w.definitions[checking]} onClose={() => setChecking(null)}
          onConfirm={async (checked) => { if (await run(() => api.post(`${path}/transition`, { to: checking, checked }))) setChecking(null); }} />
      )}
    </>
  );
}

function CriteriaCard({ criteria, editable, onChange }: { criteria: Criterion[]; editable: boolean; onChange: (next: Criterion[]) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const shown = criteria.filter((c): c is { criterion: string; done: boolean } => c.criterion !== null);
  return (
    <section className="card">
      <h2>Acceptance criteria <span className="count">{criteria.filter((c) => c.done).length}/{criteria.length}</span></h2>
      {criteria.length === 0 && <p className="placeholder">How will the team know it is done? One checkable line each.</p>}
      {shown.length < criteria.length && <p className="placeholder">Confidential.</p>}
      <ul className="plain-list wi-criteria">
        {shown.map((c, i) => (
          <li key={i}>
            <label className="check">
              <input type="checkbox" checked={c.done} disabled={!editable} onChange={() => onChange(shown.map((x, n) => (n === i ? { ...x, done: !x.done } : x)))} /> {c.criterion}
            </label>
            {editable && <button className="btn-link small" aria-label={`Remove "${c.criterion}"`} onClick={() => onChange(shown.filter((_, n) => n !== i))}>Remove</button>}
          </li>
        ))}
      </ul>
      {editable && (
        <form className="rel-form small" onSubmit={async (e) => { e.preventDefault(); if (text.trim() && (await onChange([...shown, { criterion: text.trim(), done: false }]))) setText(''); }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. The export opens in Excel" aria-label="New acceptance criterion" />
          <button className="btn small" disabled={!text.trim()}>Add</button>
        </form>
      )}
    </section>
  );
}

function LinksCard({ w, editable, onChange }: { w: WorkItem; editable: boolean; onChange: (fn: () => Promise<WorkItem>) => Promise<boolean> }) {
  const [kind, setKind] = useState<'work_item' | 'document'>('work_item');
  const [reference, setReference] = useState('');
  const submit = () => onChange(() => api.post(`/api/work-items/${w.ref}/links`, kind === 'document' ? { kind, reference: reference.trim(), url: reference.trim() } : { kind, reference: reference.trim() }));
  return (
    <section className="card">
      <h2>Related <span className="count">{w.links.length}</span></h2>
      {w.links.length === 0 && <p className="placeholder">Link related work items or a design document.</p>}
      <ul className="plain-list">
        {w.links.map((x) => (
          <li key={x.id}>
            {x.kind === 'work_item' ? <>{x.item_type && <TypeBadge type={x.item_type} />} <Link to={`/work/${x.reference}`} className="mono">{x.reference}</Link>{x.title && ` ${x.title}`} {x.status && <StatusBadge kind="work_item" status={x.status} />}</>
              : <><span className="tag">document</span> {x.url ? <a href={x.url} target="_blank" rel="noreferrer">{x.reference}</a> : x.reference}</>}
            {x.note && <span className="muted small"> · {x.note}</span>}
            {editable && <button className="btn-link small" aria-label={`Remove link to ${x.reference}`} onClick={() => onChange(() => api.del(`/api/work-items/${w.ref}/links/${x.id}`))}>Remove</button>}
          </li>
        ))}
      </ul>
      {editable && (
        <form className="rel-form small" onSubmit={async (e) => { e.preventDefault(); if (await submit()) setReference(''); }}>
          <select value={kind} onChange={(e) => setKind(e.target.value as 'work_item' | 'document')} aria-label="Kind"><option value="work_item">Work item</option><option value="document">Document (URL)</option></select>
          <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={kind === 'work_item' ? 'WI…' : 'https://…'} aria-label="Reference" />
          <button className="btn small" disabled={!reference.trim()}>Link</button>
        </form>
      )}
    </section>
  );
}
