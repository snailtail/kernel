// Service requests (#44), an optional module: the list, the page of one request (its answers, approval and tasks in
// order), the "new request" flow with the item's form generated from the catalogue, and the catalogue admin card.
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, type Guidance } from '../api';
import { askReason, askText } from '../components/Ask';
import { GuidePanel } from '../components/Guide';
import { HistoryPanel } from '../components/History';
import { useColumns, useListToolkit, type ColumnKey } from '../components/ListToolkit';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { PersonPicker, type PersonRef } from '../components/People';
import { Presence } from '../components/Presence';
import { SavedViews } from '../components/SavedViews';
import { RecordNotFound, VisibilityPanel } from '../components/Visibility';
import { formatDate, relativeTime } from '../format';
import { useApi, useSearchText } from '../hooks';
import { useLive } from '../live';
import { canEdit, isManager, useSession } from '../session';
import { useTeams } from './Teams';

type Status = 'submitted' | 'awaiting_approval' | 'in_fulfilment' | 'fulfilled' | 'rejected' | 'cancelled';
export const REQUEST_STATUS: Record<Status, string> = {
  submitted: 'Submitted', awaiting_approval: 'Awaiting approval', in_fulfilment: 'In fulfilment', fulfilled: 'Fulfilled', rejected: 'Rejected', cancelled: 'Cancelled',
};
const STATUSES = Object.keys(REQUEST_STATUS) as Status[];
type FieldType = 'text' | 'textarea' | 'choice' | 'person' | 'ci' | 'date';
const FIELD_TYPE: Record<FieldType, string> = { text: 'Short text', textarea: 'Long text', choice: 'Choice', person: 'Person', ci: 'CI', date: 'Date' };
interface Field { key: string; label: string; type: FieldType; required: boolean; choices: string[] }
type TaskKind = 'manual' | 'change' | 'webhook';
interface TaskSpec { title: string; team_id: number | null; kind?: TaskKind; webhook_id?: number | null }
const TASK_KIND: Record<TaskKind, string> = { manual: 'By a person', change: 'Standard change', webhook: 'Webhook' };
interface Item {
  id: number; name: string; description: string; form: Field[]; approval: string; approval_label: string; fulfilment_tasks: TaskSpec[];
  standard_change_template_id: number | null; logger_may_approve: boolean;
  sla_id: number | null; sla: string | null; active: boolean; service: { ref: string; name: string };
}
interface Row {
  ref: string; title: string; status: Status; priority: number; item: string; service_ref: string; service_name: string; requester: string;
  created_at: string; updated_at: string; resolution_due_at: string | null; at_risk: boolean; open_task: string | null; open_task_team: string | null; open_task_assignee: string | null;
}
interface Task { kind: TaskKind; change_ref: string | null; webhook: string | null; by_change: boolean; id: number; position: number; title: string; status: 'pending' | 'open' | 'done' | 'cancelled'; note: string | null; team_id: number | null; team: string | null; assignee_id: number | null; assignee: string | null; done_at: string | null; done_by: string | null; may_complete: boolean }
interface Clock { state: string; due_at: string | null; remaining_minutes: number | null; target_minutes: number | null }
interface Detail {
  id: number; ref: string; title: string; status: Status; priority: number; item: { id: number; name: string }; service: { ref: string; name: string };
  requester: { id: number; name: string; email?: string | null }; on_behalf_of: string | null;
  answers: { key: string; label: string; type: FieldType; value?: string | number | null; answer_text?: string | null; display?: string | null }[];
  approval: { kind: string; approvers: string[]; decided_by: string | null; decided_at: string | null; reject_reason: string | null; may_decide: boolean };
  cancel_reason: string | null; tasks: Task[];
  sla: { name: string; paused: boolean; response: Clock; resolution: Clock } | null;
  links: { id: number; kind: string; reference: string; system: string; url: string; note: string }[];
  activity: { id: number; kind: string; body: string; data: any; channel: string; created_at: string; user_name: string | null }[];
  restricted: boolean; restricted_teams: number[]; classification: 'normal' | 'confidential'; confidential_masked?: boolean; created_by: number | null;
  created_at: string; resolved_at: string | null; transitions: string[]; next_steps: Guidance;
}

export function RequestStatusBadge({ status }: { status: Status }) {
  return <span className={`badge req-${status}`}>{REQUEST_STATUS[status]}</span>;
}

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'status', label: 'Status' }, { key: 'assignee', label: 'Open task' }, { key: 'service', label: 'Item' }, { key: 'updated', label: 'Updated' },
];

export function RequestsPage() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useSearchText();
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setCreating(true);
    const next = new URLSearchParams(params);
    next.delete('new');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  const set = (k: string, v: string) => setParams((prev) => { const n = new URLSearchParams(prev); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const query = new URLSearchParams([...params].filter(([k]) => k !== 'new'));
  const { data, loading, refresh } = useApi<Row[]>(`/api/requests?${query}`);
  useLive(['request:*'], refresh);
  const tk = useListToolkit({ list: 'requests', rows: data, idOf: (r) => r.ref, hrefOf: (r) => `/requests/${r.ref}`, filter: query.toString(), onChanged: refresh });
  const cols = useColumns('requests', COLUMNS);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Service requests</h1>
          <p className="muted">Accounts, access, new VMs: approved when needed, then fulfilled task by task. Never counted as incidents.</p>
        </div>
        <SavedViews list="requests" />
        {canEdit(user) && <button className="btn primary page-new" onClick={() => setCreating(true)}>New request</button>}
      </header>
      <div className="filters">
        <input className="search" placeholder="Search requests…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={params.get('status') ?? 'open'} onChange={(e) => set('status', e.target.value === 'open' ? '' : e.target.value)} aria-label="Status">
          <option value="open">Open</option>{STATUSES.map((s) => <option key={s} value={s}>{REQUEST_STATUS[s]}</option>)}<option value="all">All</option>
        </select>
        <select value={params.get('task') ?? ''} onChange={(e) => set('task', e.target.value)} aria-label="Task">
          <option value="">Any task</option><option value="mine">My tasks</option><option value="my_teams">My teams' tasks</option>
        </select>
        <label className="check"><input type="checkbox" checked={params.get('awaiting_me') === 'true'} onChange={(e) => set('awaiting_me', e.target.checked ? 'true' : '')} /> Waiting for my approval</label>
        {cols.picker}
      </div>
      {tk.scope}
      <section className={`card flush ${loading ? 'is-loading' : ''}`} {...cols.container}>
        {data?.length === 0 ? <p className="empty">No requests match.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{tk.selectAll && <th className="check-col">{tk.selectAll}</th>}<th>Ref</th><th>Title</th><th data-col="status">Status</th><th className="hide-sm" data-col="assignee">Open task</th><th className="hide-sm" data-col="service">Item</th><th className="hide-sm" data-col="updated">Updated</th></tr></thead>
              <tbody>
                {data?.map((r, n) => (
                  <tr key={r.ref} {...tk.rowProps(r, n)}>
                    {tk.selectAll && <td className="check-col">{tk.select(r, n)}</td>}
                    <td className="mono nowrap"><Link to={`/requests/${r.ref}`}>{r.ref}</Link></td>
                    <td className="title-cell"><Link to={`/requests/${r.ref}`}>{r.title}</Link>{r.at_risk && <span className="badge overdue">SLA</span>}<div className="muted small">for {r.requester}</div></td>
                    <td data-col="status"><RequestStatusBadge status={r.status} /></td>
                    <td className="hide-sm small" data-col="assignee">{r.open_task ? <>{r.open_task}<div className="muted">{r.open_task_assignee ?? r.open_task_team ?? 'Anyone'}</div></> : '–'}</td>
                    <td className="hide-sm small" data-col="service">{r.item}<div className="muted">{r.service_name}</div></td>
                    <td className="hide-sm small nowrap" data-col="updated">{relativeTime(r.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {tk.bar}
      {creating && <NewRequest onClose={() => setCreating(false)} onDone={(ref) => navigate(`/requests/${ref}`)} />}
    </>
  );
}

// ---- New request ---------------------------------------------------------------------------

/** One answer input, by the field's type. People are picked from People; CIs and dates are typed. */
function AnswerInput({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  const [person, setPerson] = useState<string | null>(null);
  const id = `answer-${field.key}`;
  const label = <span>{field.label}{field.required && <span className="muted"> *</span>}</span>;
  switch (field.type) {
    case 'textarea':
      return <label className="full" htmlFor={id}>{label}<textarea id={id} rows={3} required={field.required} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} /></label>;
    case 'choice':
      return (
        <label htmlFor={id}>{label}
          <select id={id} required={field.required} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose…</option>{field.choices.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      );
    case 'date':
      return <label htmlFor={id}>{label}<input id={id} type="date" required={field.required} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} /></label>;
    case 'ci':
      return <label htmlFor={id}>{label}<input id={id} required={field.required} placeholder="CI ref, e.g. CI000123" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} /></label>;
    case 'person':
      return (
        <div className="field">
          <span className="label">{label}</span>
          {value ? <p>{person ?? `Person #${value}`} <button type="button" className="btn-link small" onClick={() => onChange(undefined)}>Change</button></p>
            : <PersonPicker placeholder="Find a person…" onPick={async (p) => { const pid = await personId(p); setPerson('label' in p && p.label ? p.label : 'name' in p ? p.name : null); onChange(pid); }} />}
        </div>
      );
    default:
      return <label htmlFor={id}>{label}<input id={id} required={field.required} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} /></label>;
  }
}

/** A picked contact, added to People first when it is new. */
async function personId(p: PersonRef) {
  if ('id' in p) return p.id;
  return (await api.post<{ id: number }>('/api/people', { name: p.name, email: p.email ?? null })).id;
}

function NewRequest({ onClose, onDone }: { onClose: () => void; onDone: (ref: string) => void }) {
  const { data: items } = useApi<Item[]>('/api/request-items');
  const [item, setItem] = useState<Item | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [requester, setRequester] = useState<{ id: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const services = [...new Map((items ?? []).map((i) => [i.service.ref, i.service.name])).entries()];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!item) return;
    setError(null);
    setBusy(true);
    try {
      const filled = Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== undefined && v !== ''));
      const r = await api.post<Detail>('/api/requests', { item_id: item.id, answers: filled, ...(requester ? { requester: { id: requester.id } } : {}) });
      onDone(r.ref);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={item ? item.name : 'New request'} onClose={onClose}>
      {!item ? (
        <div className="catalogue-picker">
          <p className="muted small">What does the person need? Pick from the catalogue.</p>
          {items?.length === 0 && <p className="placeholder">The catalogue is empty. A manager adds items under Administration.</p>}
          {services.map(([ref, name]) => (
            <section key={ref}>
              <h3>{name}</h3>
              <ul className="plain-list catalogue-items">
                {items!.filter((i) => i.service.ref === ref).map((i) => (
                  <li key={i.id}>
                    <button type="button" className="catalogue-item" onClick={() => { setItem(i); setAnswers({}); }}>
                      <strong>{i.name}</strong>
                      {i.description && <span className="muted small">{i.description}</span>}
                      <span className="muted small">{i.approval === 'none' ? 'No approval' : `Approved by ${i.approval_label.toLowerCase()}`} · {i.fulfilment_tasks.length} task{i.fulfilment_tasks.length === 1 ? '' : 's'}{i.sla ? ` · ${i.sla}` : ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <form className="form" onSubmit={submit}>
          {item.description && <p className="muted small full">{item.description}</p>}
          <div className="field full">
            <span className="label">For</span>
            {requester ? <p>{requester.label} <button type="button" className="btn-link small" onClick={() => setRequester(null)}>Change</button></p>
              : <PersonPicker placeholder="Yourself, or find the person it is for…" onPick={async (p) => setRequester({ id: await personId(p), label: 'label' in p && p.label ? p.label : 'name' in p ? p.name : '' })} />}
          </div>
          {item.form.map((f) => <AnswerInput key={f.key} field={f} value={answers[f.key]} onChange={(v) => setAnswers({ ...answers, [f.key]: v })} />)}
          <p className="muted small full">{item.approval === 'none' ? 'No approval needed: the first task starts at once.' : `${item.approval_label} approves it before work starts.`}</p>
          {error && <div className="error full">{error}</div>}
          <div className="actions full">
            <button type="button" className="btn" onClick={() => setItem(null)}>Back</button>
            <button className="btn primary" disabled={busy}>Submit</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---- One request ---------------------------------------------------------------------------

function clockLabel(c: Clock, paused: boolean) {
  if (c.state === 'none') return '–';
  if (c.state === 'met') return 'Met';
  if (c.state === 'breached') return 'Breached';
  if (paused) return 'Paused (waiting for approval)';
  const m = c.remaining_minutes ?? 0;
  return `${m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`} left${c.state === 'at_risk' ? ' (at risk)' : ''}`;
}

function TaskList({ r, onRun }: { r: Detail; onRun: (fn: () => Promise<Detail>) => Promise<boolean> }) {
  const { user } = useSession();
  if (!r.tasks.length) {
    return <p className="placeholder">{r.status === 'awaiting_approval' ? 'The tasks start when the request is approved.' : 'No tasks.'}</p>;
  }
  const done = async (t: Task) => {
    const note = await askText(`Done: ${t.title}`, 'Note (optional)', { confirmLabel: 'Mark done', message: 'What was done, for the next person and the history.' });
    if (note === null) return;
    await onRun(() => api.post(`/api/requests/${r.ref}/tasks/${t.id}/complete`, { note }));
  };
  return (
    <ol className="task-steps">
      {r.tasks.map((t) => (
        <li key={t.id} className={`task-step ${t.status}`}>
          <div className="task-step-head">
            <strong>{t.title}</strong>
            <span className={`tag task-${t.status}`}>{t.status === 'pending' ? 'Waiting' : t.status === 'open' ? 'Open' : t.status === 'done' ? 'Done' : 'Cancelled'}</span>
          </div>
          <div className="muted small">
            {t.kind === 'change' && <>{t.change_ref ? <Link to={`/changes/${t.change_ref}`} className="mono">{t.change_ref}</Link> : 'Standard change'} · </>}
            {t.kind === 'webhook' && <>Automatic{t.webhook ? ` (${t.webhook})` : ''} · </>}
            {t.team ?? 'Anyone'}{t.assignee ? ` · ${t.assignee}` : ''}
            {t.done_at && ` · done ${relativeTime(t.done_at)}${t.done_by ? ` by ${t.done_by}` : ''}`}
          </div>
          {t.note && <p className="small">{t.note}</p>}
          {t.status === 'open' && t.by_change && <p className="muted small">Recording the outcome on {t.change_ref} completes this task.</p>}
          {t.status === 'open' && t.may_complete && (
            <div className="actions">
              {t.assignee_id !== user.id && <button className="btn small" onClick={() => onRun(() => api.patch(`/api/requests/${r.ref}/tasks/${t.id}`, { assignee_id: user.id }))}>Take it</button>}
              <button className="btn small primary" onClick={() => done(t)}>Mark done</button>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

export function RequestPage() {
  const { ref } = useParams();
  const { user } = useSession();
  const { data: r, setData, error, reload, refresh } = useApi<Detail>(`/api/requests/${ref}`);
  const others = useLive([r && `request:${r.id}`], refresh, { presence: true });
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // A note is internal unless the person chooses to reply to the requester (#45): replies show in the portal and go by mail.
  const [toRequester, setToRequester] = useState(false);
  if (error) return <RecordNotFound refId={ref ?? ''} error={error} onOpened={reload} />;
  if (!r) return null;
  const path = `/api/requests/${r.ref}`;
  const editable = canEdit(user);
  const run = async (fn: () => Promise<Detail>) => {
    setActionError(null);
    try {
      setData(await fn());
      return true;
    } catch (err) {
      setActionError((err as Error).message);
      return false;
    }
  };
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
          <RequestStatusBadge status={r.status} />
          <span className="tag">{r.item.name}</span>
          <span className="muted small">For {r.requester.name}{r.on_behalf_of ? `, logged by ${r.on_behalf_of}` : ''} {relativeTime(r.created_at)}</span>
        </div>
        <div className="transitions">
          {r.approval.may_decide && <><button className="btn primary" onClick={() => decide('approve')}>Approve</button><button className="btn danger" onClick={() => decide('reject')}>Reject</button></>}
          {editable && r.transitions.includes('cancelled') && <button className="btn" onClick={cancel}>Cancel request</button>}
        </div>
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
              <form className="comment-form" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post(`${path}/comments`, { body: note, to_requester: toRequester }))) { setNote(''); setToRequester(false); } }}>
                <div className="note-audience" role="radiogroup" aria-label="Who reads this">
                  <label className="check"><input type="radio" name="note-audience" checked={!toRequester} onChange={() => setToRequester(false)} /> Internal note</label>
                  <label className="check"><input type="radio" name="note-audience" checked={toRequester} onChange={() => setToRequester(true)} /> Reply to {r.requester.name}</label>
                </div>
                <textarea rows={2} placeholder={toRequester ? `Reply to ${r.requester.name}: they see it in the portal and by email` : 'Add a note'} value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="actions"><button className="btn primary" disabled={!note.trim()}>{toRequester ? 'Send reply' : 'Add note'}</button></div>
              </form>
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

// ---- The catalogue (Administration) --------------------------------------------------------

/** Managers keep the catalogue: per service, a short form, who approves, and the tasks in order. */
export function RequestCatalogueCard() {
  const { user } = useSession();
  const { data, reload } = useApi<Item[]>(isManager(user) ? '/api/request-items?inactive=true' : null);
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  if (!data) return null;
  return (
    <section className="card">
      <div className="section-head"><h2>Request catalogue</h2><button className="btn-link" onClick={() => setEditing('new')}>+ Item</button></div>
      <p className="muted small">What people can ask for, per service: a form of at most 10 fields, who approves, and the tasks that fulfil it, in order.</p>
      {data.length === 0 ? <p className="placeholder">No items yet. Start with the three most common requests, such as a new account or access to a system.</p> : (
        <table className="table compact">
          <thead><tr><th>Item</th><th className="hide-sm">Service</th><th className="hide-sm">Approval</th><th>Tasks</th><th /></tr></thead>
          <tbody>
            {data.map((i) => (
              <tr key={i.id} className={i.active ? '' : 'muted'}>
                <td>{i.name}{!i.active && <span className="tag">inactive</span>}</td>
                <td className="hide-sm">{i.service.name}</td>
                <td className="hide-sm small">{i.approval_label}</td>
                <td>{i.fulfilment_tasks.length}</td>
                <td><button className="btn-link small" onClick={() => setEditing(i)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <ItemModal item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </section>
  );
}

const keyOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f$1').slice(0, 40) || 'field';

function ItemModal({ item, onClose, onDone }: { item: Item | null; onClose: () => void; onDone: () => void }) {
  const teams = useTeams();
  const { data: slas } = useApi<{ id: number; name: string }[]>('/api/slas');
  const [form, setForm] = useState({
    service: item?.service.ref ?? '', name: item?.name ?? '', description: item?.description ?? '', approval: item?.approval ?? 'none',
    sla_id: item?.sla_id ? String(item.sla_id) : '', active: item?.active ?? true, logger_may_approve: item?.logger_may_approve ?? false,
    standard_change_template_id: item?.standard_change_template_id ? String(item.standard_change_template_id) : '',
  });
  const { data: options } = useApi<{ templates: { id: number; name: string }[]; webhooks: { id: number; name: string }[] }>('/api/request-items/options');
  const [fields, setFields] = useState<Field[]>(item?.form ?? []);
  const [tasks, setTasks] = useState<TaskSpec[]>(item?.fulfilment_tasks ?? [{ title: '', team_id: null, kind: 'manual' }]);
  const [error, setError] = useState<string | null>(null);
  const approvalKind = form.approval.startsWith('team:') ? 'team' : form.approval;
  const setField = (n: number, patch: Partial<Field>) => setFields(fields.map((f, i) => (i === n ? { ...f, ...patch } : f)));
  const setTask = (n: number, patch: Partial<TaskSpec>) => setTasks(tasks.map((t, i) => (i === n ? { ...t, ...patch } : t)));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = {
      ...form, sla_id: form.sla_id ? Number(form.sla_id) : null, standard_change_template_id: form.standard_change_template_id ? Number(form.standard_change_template_id) : null,
      form: fields.map((f) => ({ ...f, key: f.key || keyOf(f.label), choices: f.type === 'choice' ? f.choices : [] })),
      fulfilment_tasks: tasks.filter((t) => t.title.trim()),
      ...(tasks.some((t) => t.kind === 'change') ? {} : { standard_change_template_id: null }),
    };
    try {
      if (item) await api.put(`/api/request-items/${item.id}`, body);
      else await api.post('/api/request-items', body);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title={item ? `Edit ${item.name}` : 'New catalogue item'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Access to a system" /></label>
        <label>Service <span className="muted small">(ref)</span><input required value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })} placeholder="SVC…" /></label>
        <label className="full">Description<textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label>Approval
          <select value={approvalKind} onChange={(e) => setForm({ ...form, approval: e.target.value === 'team' ? `team:${teams[0]?.id ?? 0}` : e.target.value })}>
            <option value="none">No approval</option><option value="requester_manager">The requester's manager</option><option value="service_owner">The service owner</option><option value="team">A team</option>
          </select>
        </label>
        {approvalKind === 'team' ? (
          <label>Approving team
            <select value={form.approval.slice(5)} onChange={(e) => setForm({ ...form, approval: `team:${e.target.value}` })}>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          </label>
        ) : (
          <label>SLA
            <select value={form.sla_id} onChange={(e) => setForm({ ...form, sla_id: e.target.value })}><option value="">The service's SLA</option>{slas?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </label>
        )}
        {approvalKind === 'team' && (
          <label className="full">SLA
            <select value={form.sla_id} onChange={(e) => setForm({ ...form, sla_id: e.target.value })}><option value="">The service's SLA</option>{slas?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </label>
        )}

        <fieldset className="full builder">
          <legend>Form <span className="muted small">({fields.length} of 10 fields)</span></legend>
          {fields.map((f, n) => (
            <div key={n} className="builder-row">
              <input aria-label="Field label" required placeholder="Label" value={f.label} onChange={(e) => setField(n, { label: e.target.value, ...(item?.form.some((x) => x.key === f.key) ? {} : { key: keyOf(e.target.value) }) })} />
              <select aria-label="Field type" value={f.type} onChange={(e) => setField(n, { type: e.target.value as FieldType })}>{Object.entries(FIELD_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <label className="check"><input type="checkbox" checked={f.required} onChange={(e) => setField(n, { required: e.target.checked })} /> Required</label>
              <button type="button" className="btn-link small" aria-label={`Remove ${f.label || 'field'}`} onClick={() => setFields(fields.filter((_, i) => i !== n))}>Remove</button>
              {f.type === 'choice' && <input className="builder-choices" aria-label="Choices" placeholder="Choices, separated by commas" value={f.choices.join(', ')} onChange={(e) => setField(n, { choices: e.target.value.split(',').map((c) => c.trim()).filter(Boolean) })} />}
            </div>
          ))}
          {fields.length < 10 && <button type="button" className="btn small" onClick={() => setFields([...fields, { key: '', label: '', type: 'text', required: false, choices: [] }])}>+ Field</button>}
        </fieldset>

        <fieldset className="full builder">
          <legend>Fulfilment tasks, in order</legend>
          {tasks.map((t, n) => (
            <div key={n} className="builder-row">
              <span className="muted">{n + 1}.</span>
              <input aria-label="Task" required={n === 0} placeholder="What to do" value={t.title} onChange={(e) => setTask(n, { title: e.target.value })} />
              <select aria-label="Team" value={t.team_id ?? ''} onChange={(e) => setTask(n, { team_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Anyone</option>{teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <select aria-label="How it is done" value={t.kind ?? 'manual'} onChange={(e) => setTask(n, { kind: e.target.value as TaskKind, webhook_id: e.target.value === 'webhook' ? options?.webhooks[0]?.id ?? null : null })}>
                {(Object.keys(TASK_KIND) as TaskKind[]).filter((k) => k === 'manual' || (k === 'change' ? !!options?.templates.length : !!options?.webhooks.length)).map((k) => <option key={k} value={k}>{TASK_KIND[k]}</option>)}
              </select>
              {t.kind === 'webhook' && (
                <select aria-label="Webhook" value={t.webhook_id ?? ''} onChange={(e) => setTask(n, { webhook_id: Number(e.target.value) })}>{options?.webhooks.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
              )}
              {tasks.length > 1 && <button type="button" className="btn-link small" aria-label={`Remove task ${n + 1}`} onClick={() => setTasks(tasks.filter((_, i) => i !== n))}>Remove</button>}
            </div>
          ))}
          {tasks.length < 20 && <button type="button" className="btn small" onClick={() => setTasks([...tasks, { title: '', team_id: null, kind: 'manual' }])}>+ Task</button>}
          {tasks.some((t) => t.kind === 'change') && (
            <label>Standard change template
              <select required value={form.standard_change_template_id} onChange={(e) => setForm({ ...form, standard_change_template_id: e.target.value })}>
                <option value="">Choose…</option>{options?.templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
          )}
          <p className="muted small">A standard change task is completed by the change's outcome; a webhook task by the webhook calling back.</p>
        </fieldset>
        {form.approval !== 'none' && <label className="check full"><input type="checkbox" checked={form.logger_may_approve} onChange={(e) => setForm({ ...form, logger_may_approve: e.target.checked })} /> The person who logs a request may also approve it (the history shows it)</label>}
        {item && <label className="check full"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> In the catalogue (untick to retire it; existing requests keep it)</label>}
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}
