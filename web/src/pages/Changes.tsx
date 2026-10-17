import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, type Guidance } from '../api';
import { AffectedCisPanel, type AffectedCi, type AffectedService } from '../components/AffectedCis';
import { GuidePanel } from '../components/Guide';
import { Markdown } from '../components/Markdown';
import { richPaste } from '../components/RichPaste';
import { RecordNotFound, VisibilityPanel } from '../components/Visibility';
import { DevLinksPanel } from '../components/DevLinks';
import { SummaryButton } from '../components/Ai';
import { AttachmentsPanel } from '../components/Attachments';
import { Modal } from '../components/Modal';
import { useColumns, useListToolkit, type ColumnKey } from '../components/ListToolkit';
import { SavedViews } from '../components/SavedViews';
import { Term } from '../components/Glossary';
import { formatDate, relativeTime } from '../format';
import { useLive } from '../live';
import { Presence } from '../components/Presence';
import { useApi, useOpenOnNew } from '../hooks';
import { useSession } from '../session';
import { HistoryPanel } from '../components/History';

type Status = 'draft' | 'assess' | 'authorize' | 'scheduled' | 'implementing' | 'review' | 'closed' | 'rejected' | 'cancelled';
export const CHANGE_STATUS: Record<Status, string> = {
  draft: 'Draft', assess: 'Assess', authorize: 'Authorise', scheduled: 'Scheduled', implementing: 'Implementing', review: 'Review', closed: 'Closed', rejected: 'Rejected', cancelled: 'Cancelled',
};
const OUTCOME: Record<string, string> = { successful: 'Successful', failed: 'Failed', rolled_back: 'Rolled back' };
interface Row { id: number; ref: string; title: string; change_type: string; status: Status; risk: string | null; planned_start: string | null; planned_end: string | null; outcome: string | null; source: string; assignee: string | null; problem_ref: string | null; cis: string[] | null }
interface Change extends Row {
  description: string; template: string | null; template_id: number | null; implementation_plan: string; test_plan: string; backout_plan: string; review: string;
  risk: string; risk_assessed: string; risk_reason: string; risk_overridden: boolean; actual_start: string | null; actual_end: string | null; assignee_id: number | null;
  requested_by: string | null; problem_title: string | null; problem_status: string | null; created_at: string;
  affected_cis: AffectedCi[]; affected_services: AffectedService[];
  votes: { approver: string; decision: string; comment: string; created_at: string }[]; approvals: { required: number; approved: number }; can_vote: boolean;
  collisions: { ref: string; title: string; ci: string; planned_start: string; planned_end: string }[]; freezes: { name: string; starts_at: string; ends_at: string; reason: string }[];
  related_incidents: { ref: string; title: string; status: string; created_at: string }[];
  links: { id: number; kind: string; reference: string; system: string; url: string }[];
  activity: { id: number; kind: string; body: string; data: any; channel: string; created_at: string; user_name: string | null }[];
  next_steps: Guidance;
}

export function ChangeStatusBadge({ status }: { status: Status }) {
  return <span className={`badge chg-${status}`}>{CHANGE_STATUS[status]}</span>;
}
const fmtWindow = (s: string | null, e: string | null) => (s ? `${formatDate(s)}${e ? ` – ${formatDate(e)}` : ''}` : 'Not planned');

export function ChangesPage() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'list';
  const set = (k: string, v: string) => setParams((prev) => { const n = new URLSearchParams(prev); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const [creating, setCreating] = useState(false);
  useOpenOnNew(() => setCreating(true));
  const navigate = useNavigate();
  const manager = user.role === 'admin' || user.role === 'problem_manager';
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Changes</h1>
          <p className="muted">Assess the risk, authorise, schedule without collisions or freezes, and review.</p>
        </div>
        {tab === 'list' && <SavedViews list="changes" />}
        {user.role !== 'viewer' && <button className="btn primary page-new" onClick={() => setCreating(true)}>New change</button>}
      </header>
      <div className="seg-toggle tabs" role="tablist">
        {[['list', 'Changes'], ['schedule', 'Schedule'], ['templates', 'Standard changes'], ['freezes', 'Freezes']].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setParams({ tab: id }, { replace: true })}>{label}</button>
        ))}
      </div>
      {tab === 'list' && <ChangeList params={params} set={set} />}
      {tab === 'schedule' && <Schedule />}
      {tab === 'templates' && <Templates manager={manager} />}
      {tab === 'freezes' && <Freezes manager={manager} />}
      {creating && <NewChange onClose={() => setCreating(false)} onDone={(ref) => navigate(`/changes/${ref}`)} />}
    </>
  );
}

const CHANGE_COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'risk', label: 'Risk' }, { key: 'window', label: 'Window' }, { key: 'cis', label: 'CIs' },
];

function ChangeList({ params, set }: { params: URLSearchParams; set: (k: string, v: string) => void }) {
  const query = new URLSearchParams([...params].filter(([k]) => k !== 'tab'));
  const { data, loading, refresh } = useApi<Row[]>(`/api/changes?${query}`);
  useLive(['change:*'], refresh);
  const { user } = useSession();
  const tk = useListToolkit({ list: 'changes', rows: data, idOf: (c) => c.ref, hrefOf: (c) => `/changes/${c.ref}`, filter: query.toString(), onChanged: refresh });
  const cols = useColumns('changes', CHANGE_COLUMNS);
  return (
    <>
      <div className="filters">
        <select value={params.get('status') ?? 'open'} onChange={(e) => set('status', e.target.value === 'open' ? '' : e.target.value)}>
          <option value="open">Open</option>{Object.entries(CHANGE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}<option value="all">All</option>
        </select>
        <select value={params.get('type') ?? ''} onChange={(e) => set('type', e.target.value)}><option value="">Any type</option><option value="standard">Standard</option><option value="normal">Normal</option><option value="emergency">Emergency</option></select>
        {(user.role === 'admin' || user.role === 'problem_manager') && <label className="check"><input type="checkbox" checked={params.get('awaiting_my_vote') === 'true'} onChange={(e) => set('awaiting_my_vote', e.target.checked ? 'true' : '')} /> Awaiting my approval</label>}
        {cols.picker}
      </div>
      {tk.scope}
      <section className={`card flush ${loading ? 'is-loading' : ''}`} {...cols.container}>
        {data?.length === 0 ? <p className="empty">No changes match.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{tk.selectAll && <th className="check-col">{tk.selectAll}</th>}<th>Ref</th><th>Title</th><th data-col="type">Type</th><th data-col="status">Status</th><th className="hide-sm" data-col="risk">Risk</th><th className="hide-sm" data-col="window">Window</th><th className="hide-sm" data-col="cis">CIs</th></tr></thead>
              <tbody>
                {data?.map((c, n) => (
                  <tr key={c.id} {...tk.rowProps(c, n)}>
                    {tk.selectAll && <td className="check-col">{tk.select(c, n)}</td>}
                    <td className="mono nowrap"><Link to={`/changes/${c.ref}`}>{c.ref}</Link></td>
                    <td className="title-cell"><Link to={`/changes/${c.ref}`}>{c.title}</Link>{c.source === 'pipeline' && <span className="tag">pipeline</span>}</td>
                    <td data-col="type"><span className={`tag type-${c.change_type}`}>{c.change_type}</span></td>
                    <td data-col="status"><ChangeStatusBadge status={c.status} />{c.outcome && <div className="muted small">{OUTCOME[c.outcome]}</div>}</td>
                    <td className="hide-sm" data-col="risk">{c.risk ?? <span className="muted">assessed</span>}</td>
                    <td className="hide-sm small nowrap" data-col="window">{fmtWindow(c.planned_start, c.planned_end)}</td>
                    <td className="hide-sm small" data-col="cis">{c.cis?.join(', ') ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {tk.bar}
    </>
  );
}

function Schedule() {
  const { data } = useApi<{ changes: (Row & { cis: string[] | null })[]; freezes: { id: number; name: string; starts_at: string; ends_at: string; reason: string }[]; collisions: { change: string; with: string; ci_name: string }[] }>('/api/changes/schedule');
  if (!data) return null;
  // Group by day of the planned start; freezes are shown above the days they cover.
  const days = new Map<string, typeof data.changes>();
  for (const c of data.changes) {
    const d = new Date(c.planned_start!).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    days.set(d, [...(days.get(d) ?? []), c]);
  }
  const colliding = new Set(data.collisions.map((c) => c.change));
  return (
    <>
      {data.freezes.map((f) => <p key={f.id} className="warn-box">Change freeze <strong>{f.name}</strong>: {formatDate(f.starts_at)} – {formatDate(f.ends_at)}{f.reason && ` · ${f.reason}`}</p>)}
      {days.size === 0 && <p className="empty">Nothing planned in the next 30 days.</p>}
      <div className="schedule">
        {[...days.entries()].map(([day, list]) => (
          <section key={day} className="card">
            <h2>{day}</h2>
            <ul className="work-list">
              {list.map((c) => (
                <li key={c.ref} className={colliding.has(c.ref) ? 'collides' : ''}>
                  <div>
                    <Link to={`/changes/${c.ref}`} className="mono">{c.ref}</Link> {c.title} <span className={`tag type-${c.change_type}`}>{c.change_type}</span>
                    <div className="muted small">{new Date(c.planned_start!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–{new Date(c.planned_end!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {c.cis?.join(', ') ?? 'no CIs'}</div>
                    {colliding.has(c.ref) && <div className="small attention">Collides with {data.collisions.filter((x) => x.change === c.ref).map((x) => `${x.with} on ${x.ci_name}`).join(', ')}</div>}
                  </div>
                  <ChangeStatusBadge status={c.status} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

function Templates({ manager }: { manager: boolean }) {
  const { data, reload } = useApi<{ id: number; name: string; description: string; max_risk: string; ci_types: string[]; implementation_plan: string; test_plan: string; backout_plan: string; active: boolean }[]>('/api/change-templates');
  const { data: types } = useApi<{ name: string; label: string; class: string }[]>('/api/ci-types');
  const [editing, setEditing] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <div className="section-head"><p className="muted">Standard changes are pre-approved, low-risk and repeatable: they need no authorisation. Pipelines can register them automatically.</p>{manager && <button className="btn primary" onClick={() => setEditing({ name: '', description: '', max_risk: 'low', ci_types: [], implementation_plan: '', test_plan: '', backout_plan: '', active: true })}>New template</button>}</div>
      <div className="rule-list">
        {data?.map((t) => (
          <button key={t.id} className={`card rule-card ${t.active ? '' : 'disabled'}`} disabled={!manager} onClick={() => setEditing(t)}>
            <strong>{t.name}</strong> <span className="muted small">#{t.id}</span>{!t.active && <span className="tag">inactive</span>}
            <div className="muted small">{t.description || t.implementation_plan.slice(0, 120)}</div>
            <div className="small">Up to {t.max_risk} risk · {t.ci_types.length ? t.ci_types.join(', ') : 'any CI type'}</div>
          </button>
        ))}
      </div>
      {data?.length === 0 && <p className="empty">No standard change templates yet.</p>}
      {editing && (
        <Modal title={editing.id ? `Edit ${editing.name}` : 'New standard change template'} onClose={() => setEditing(null)}>
          <form className="form" onSubmit={async (e) => {
            e.preventDefault();
            const { id, created_by: _c, created_at: _d, ...body } = editing;
            delete (body as any).id;
            try { if (id) await api.put(`/api/change-templates/${id}`, body); else await api.post('/api/change-templates', body); setEditing(null); reload(); } catch (err) { setError((err as Error).message); }
          }}>
            <label className="full">Name<input required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <label className="full">Description<textarea rows={2} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></label>
            <label>Pre-approved up to<select value={editing.max_risk} onChange={(e) => setEditing({ ...editing, max_risk: e.target.value })}><option value="low">Low risk</option><option value="medium">Medium risk</option><option value="high">High risk</option></select></label>
            <label>For CI types<select multiple size={4} value={editing.ci_types} onChange={(e) => setEditing({ ...editing, ci_types: [...e.target.selectedOptions].map((o) => o.value) })}>{types?.filter((t) => t.class === 'ci').map((t) => <option key={t.name} value={t.name}>{t.label}</option>)}</select><span className="muted small">None selected: any type</span></label>
            <label className="full">Implementation plan<textarea required rows={3} value={editing.implementation_plan} onChange={(e) => setEditing({ ...editing, implementation_plan: e.target.value })} /></label>
            <label className="full">Test plan<textarea rows={2} value={editing.test_plan} onChange={(e) => setEditing({ ...editing, test_plan: e.target.value })} /></label>
            <label className="full">Backout plan<textarea required rows={2} value={editing.backout_plan} onChange={(e) => setEditing({ ...editing, backout_plan: e.target.value })} /></label>
            <label className="check full"><input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Active</label>
            {error && <div className="error full">{error}</div>}
            <div className="actions full"><button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button><button className="btn primary">Save</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}

function Freezes({ manager }: { manager: boolean }) {
  const { data, reload } = useApi<{ id: number; name: string; starts_at: string; ends_at: string; reason: string }[]>('/api/change-freezes');
  const day = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 16);
  const [form, setForm] = useState({ name: '', starts_at: day(7), ends_at: day(14), reason: '' });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid-2 wide-left">
      <section className="card">
        <h2>Change freezes</h2>
        <p className="muted small">Normal and standard changes cannot be scheduled in a freeze; emergency changes can, and the change authority may override with a reason.</p>
        {data?.length === 0 && <p className="placeholder">No freezes.</p>}
        <ul className="work-list">
          {data?.map((f) => (
            <li key={f.id}>
              <div><strong>{f.name}</strong><div className="muted small">{formatDate(f.starts_at)} – {formatDate(f.ends_at)}{f.reason && ` · ${f.reason}`}</div></div>
              {manager && <button className="btn-icon small" aria-label="Remove freeze" onClick={async () => { await api.del(`/api/change-freezes/${f.id}`); reload(); }}>×</button>}
            </li>
          ))}
        </ul>
      </section>
      {manager && (
        <section className="card">
          <h2>Add a freeze</h2>
          <form className="form" onSubmit={async (e) => {
            e.preventDefault();
            try { await api.post('/api/change-freezes', { ...form, starts_at: new Date(form.starts_at).toISOString(), ends_at: new Date(form.ends_at).toISOString() }); reload(); } catch (err) { setError((err as Error).message); }
          }}>
            <label className="full">Name<input required placeholder="Year-end close" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label>From<input type="datetime-local" required value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} /></label>
            <label>To<input type="datetime-local" required value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} /></label>
            <label className="full">Reason<input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
            {error && <div className="error full">{error}</div>}
            <div className="actions full"><button className="btn primary">Add</button></div>
          </form>
        </section>
      )}
    </div>
  );
}

function NewChange({ onClose, onDone }: { onClose: () => void; onDone: (ref: string) => void }) {
  const { data: templates } = useApi<{ id: number; name: string; active: boolean }[]>('/api/change-templates');
  const [form, setForm] = useState({ title: '', description: '', change_type: 'normal', template_id: '', cis: '', planned_start: '', planned_end: '' });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const c = await api.post<Change>('/api/changes', {
        title: form.title, description: form.description,
        ...(form.change_type === 'standard' ? { template_id: Number(form.template_id) } : { change_type: form.change_type }),
        cis: form.cis.split(/[\s,]+/).filter(Boolean),
        ...(form.planned_start ? { planned_start: new Date(form.planned_start).toISOString() } : {}),
        ...(form.planned_end ? { planned_end: new Date(form.planned_end).toISOString() } : {}),
      });
      onDone(c.ref);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title="Request a change" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="full">What will change?<input required autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        <label>Type <span className="muted small">(<Term id="standard_change">standard</Term> · <Term id="emergency_change">emergency</Term>)</span><select value={form.change_type} onChange={(e) => setForm({ ...form, change_type: e.target.value })}><option value="normal">Normal</option><option value="standard">Standard (pre-approved)</option><option value="emergency">Emergency</option></select></label>
        {form.change_type === 'standard' && (
          <label>Template<select required value={form.template_id} onChange={(e) => setForm({ ...form, template_id: e.target.value })}><option value="">–</option>{templates?.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        )}
        <label className="full">Why and what<textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label className="full">Affected CIs <span className="muted small">(refs; risk and collisions come from them)</span><input value={form.cis} onChange={(e) => setForm({ ...form, cis: e.target.value })} /></label>
        <label>Planned start<input type="datetime-local" value={form.planned_start} onChange={(e) => setForm({ ...form, planned_start: e.target.value })} /></label>
        <label>Planned end<input type="datetime-local" value={form.planned_end} onChange={(e) => setForm({ ...form, planned_end: e.target.value })} /></label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Request</button></div>
      </form>
    </Modal>
  );
}

export function ChangePage() {
  const { ref } = useParams();
  const { user } = useSession();
  const { data: c, setData, error, reload, refresh } = useApi<Change>(`/api/changes/${ref}`);
  const others = useLive([c && `change:${c.id}`], refresh, { presence: true });
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [finishing, setFinishing] = useState<null | 'review' | 'closed'>(null);
  const [note, setNote] = useState('');
  if (error) return <RecordNotFound refId={ref ?? ''} error={error} onOpened={reload} />;
  if (!c) return null;
  const path = `/api/changes/${c.ref}`;
  const editable = user.role !== 'viewer' && !['closed', 'rejected', 'cancelled'].includes(c.status);
  const draftish = ['draft', 'assess'].includes(c.status);
  const run = async (fn: () => Promise<Change>) => {
    setActionError(null);
    try {
      setData(await fn());
      return true;
    } catch (err) {
      setActionError((err as Error).message);
      return false;
    }
  };
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
          {(c as any).contains_personal_data && <span className="badge" title="The text holds personal data (personal identity numbers or email addresses). It is kept, and counts for retention and AI handling.">Personal data</span>}
          <ChangeStatusBadge status={c.status} />
          <span className={`tag type-${c.change_type}`}>{c.change_type}{c.template && `: ${c.template}`}</span>
          <span className={`badge risk-${c.risk}`} title={c.risk_reason}>{c.risk} risk{c.risk_overridden && ` (assessed ${c.risk_assessed})`}</span>
          {c.outcome && <span className={`badge outcome-${c.outcome}`}>{OUTCOME[c.outcome]}</span>}
          <span className="muted small">Requested by {c.requested_by ?? c.source} {relativeTime(c.created_at)}</span>
        </div>
        {editable && (
          <div className="transitions">
            {c.status === 'draft' && c.change_type !== 'standard' && <button className="btn primary" onClick={() => go({ to: 'assess' })}>Submit for assessment</button>}
            {c.status === 'draft' && c.change_type === 'standard' && <button className="btn primary" onClick={() => go({ to: 'scheduled' })}>Schedule</button>}
            {c.status === 'assess' && <button className="btn primary" onClick={() => go({ to: 'authorize' })}>Submit for authorisation</button>}
            {c.status === 'authorize' && c.change_type === 'emergency' && c.approvals.approved >= c.approvals.required && <button className="btn primary" onClick={() => go({ to: 'implementing' })}>Start implementing</button>}
            {c.status === 'scheduled' && <button className="btn primary" onClick={() => go({ to: 'implementing' })}>Start implementing</button>}
            {c.status === 'implementing' && <button className="btn primary" onClick={() => setFinishing('review')}>Record outcome</button>}
            {c.status === 'review' && <button className="btn primary" onClick={() => setFinishing('closed')}>Close</button>}
            {c.status === 'rejected' && <button className="btn" onClick={() => go({ to: 'draft' })}>Rework</button>}
            {draftish && <button className="btn" onClick={() => setEditing(true)}>Edit</button>}
            {['draft', 'assess', 'authorize', 'scheduled'].includes(c.status) && <button className="btn" onClick={() => { const r = window.prompt('Why is the change cancelled?'); if (r?.trim()) go({ to: 'cancelled', cancel_reason: r.trim() }); }}>Cancel change</button>}
          </div>
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
          <section className="card">
            <h2>Notes &amp; history</h2>
            {editable && (
              <form className="comment-form" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post(`${path}/comments`, { body: note }))) setNote(''); }}>
                <textarea rows={2} placeholder="Add a note – paste screenshots and logs here" value={note} onChange={(e) => setNote(e.target.value)} {...richPaste(c.ref, setNote, setActionError)} />
                <div className="actions"><button className="btn primary" disabled={!note.trim()}>Add note</button></div>
              </form>
            )}
            <ul className="activity">
              {c.activity.map((a) => (
                <li key={a.id}>
                  <div className="activity-head">
                    <strong>{a.user_name ?? 'System'}</strong>{' '}
                    {a.kind === 'comment' ? 'added a note' : a.kind === 'status' ? `moved it from ${CHANGE_STATUS[a.data.from as Status]} to ${CHANGE_STATUS[a.data.to as Status]}` : a.kind === 'vote' ? (a.data.decision === 'approve' ? 'approved' : 'rejected') : a.body}
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
          <VisibilityPanel record={c as any} onChange={reload} />
          <DevLinksPanel recordRef={c.ref} editable={editable} />
          <AttachmentsPanel recordRef={c.ref} editable={editable} canDelete={(a) => a.uploaded_by === user.id || user.role === 'admin' || user.role === 'problem_manager'} />
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

const local = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');

function EditChange({ change: c, onClose, onDone }: { change: Change; onClose: () => void; onDone: (c: Change) => void }) {
  const [form, setForm] = useState({
    title: c.title, description: c.description, change_type: c.change_type, implementation_plan: c.implementation_plan, test_plan: c.test_plan,
    backout_plan: c.backout_plan, planned_start: local(c.planned_start), planned_end: local(c.planned_end), risk: c.risk_overridden ? c.risk : '',
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Edit ${c.ref}`} onClose={onClose}>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        const body = {
          ...form, risk: form.risk || null,
          planned_start: form.planned_start ? new Date(form.planned_start).toISOString() : null,
          planned_end: form.planned_end ? new Date(form.planned_end).toISOString() : null,
          ...(c.template_id ? { change_type: undefined } : {}),
        };
        try { onDone(await api.patch<Change>(`/api/changes/${c.ref}`, body)); } catch (err) { setError((err as Error).message); }
      }}>
        <label className="full">Title<input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        {!c.template_id && <label>Type<select value={form.change_type} onChange={(e) => setForm({ ...form, change_type: e.target.value })}><option value="normal">Normal</option><option value="emergency">Emergency</option></select></label>}
        <label>Risk<select value={form.risk} onChange={(e) => setForm({ ...form, risk: e.target.value })}><option value="">Assessed: {c.risk_assessed}</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
        <label>Planned start<input type="datetime-local" value={form.planned_start} onChange={(e) => setForm({ ...form, planned_start: e.target.value })} /></label>
        <label>Planned end<input type="datetime-local" value={form.planned_end} onChange={(e) => setForm({ ...form, planned_end: e.target.value })} /></label>
        <label className="full">Description<textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label className="full">Implementation plan<textarea rows={3} value={form.implementation_plan} onChange={(e) => setForm({ ...form, implementation_plan: e.target.value })} /></label>
        <label className="full">Test plan<textarea rows={2} value={form.test_plan} onChange={(e) => setForm({ ...form, test_plan: e.target.value })} /></label>
        <label className="full">Backout plan<textarea rows={2} value={form.backout_plan} onChange={(e) => setForm({ ...form, backout_plan: e.target.value })} /></label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

function FinishChange({ change: c, to, onClose, onDone }: { change: Change; to: 'review' | 'closed'; onClose: () => void; onDone: (c: Change) => void }) {
  const [outcome, setOutcome] = useState(c.outcome ?? 'successful');
  const [review, setReview] = useState(c.review);
  const [error, setError] = useState<string | null>(null);
  const needsReview = to === 'closed' && (c.outcome !== 'successful' || c.change_type === 'emergency');
  return (
    <Modal title={to === 'review' ? 'Record the outcome' : 'Close the change'} onClose={onClose}>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        try { onDone(await api.post<Change>(`/api/changes/${c.ref}/transition`, to === 'review' ? { to, outcome } : { to, review })); } catch (err) { setError((err as Error).message); }
      }}>
        {to === 'review' ? (
          <label className="full">Outcome<select value={outcome} onChange={(e) => setOutcome(e.target.value)}>{Object.entries(OUTCOME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        ) : (
          <label className="full">Post-implementation review {needsReview ? <span className="muted small">(required)</span> : <span className="muted small">(optional)</span>}
            <textarea rows={5} required={needsReview} placeholder="What happened, what went well, what to improve" value={review} onChange={(e) => setReview(e.target.value)} />
          </label>
        )}
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">{to === 'review' ? 'Record' : 'Close'}</button></div>
      </form>
    </Modal>
  );
}
