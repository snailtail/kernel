import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, type Guidance } from '../api';
import { GuidePanel } from '../components/Guide';
import { AffectedCisPanel, type AffectedCi, type AffectedService, type ImpactHint } from '../components/AffectedCis';
import { MajorBadge, PriorityBadge } from '../components/Badges';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { formatDate, relativeTime } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';

type IncidentStatus = 'new' | 'in_progress' | 'on_hold' | 'resolved' | 'closed';
interface IncidentRow {
  id: number; ref: string; title: string; status: IncidentStatus; priority: number; is_major: boolean; assignee: string | null;
  assignment_group: string; source: string; created_at: string; resolved_at: string | null; problem_ref: string | null; cis: string[] | null;
}
interface Incident extends IncidentRow {
  description: string; impact: number; urgency: number; category_id: number | null; category: string | null; assignee_id: number | null;
  reporter: string; hold_reason: string; resolution_code: string | null; resolution: string; reopen_count: number;
  responded_at: string | null; closed_at: string | null; problem_title: string | null; problem_status: string | null;
  affected_cis: AffectedCi[]; affected_services: AffectedService[]; impact_hint: ImpactHint | null; impact_incomplete: boolean;
  known_errors: { ref: string; title: string; workaround: string; workaround_effectiveness: string | null; ci_ref: string; ci_name: string }[];
  links: { id: number; kind: string; reference: string; system: string; url: string }[];
  activity: { id: number; kind: string; body: string; data: any; channel: string; created_at: string; user_name: string | null }[];
  next_steps: { phase: string; purpose: string; next: string; steps: { id: string; label: string; hint: string; done: boolean }[] };
}

export const INCIDENT_STATUS: Record<IncidentStatus, string> = { new: 'New', in_progress: 'In progress', on_hold: 'On hold', resolved: 'Resolved', closed: 'Closed' };
const RESOLUTION: Record<string, string> = {
  fixed: 'Fixed', workaround: 'Workaround applied', problem_fixed: 'Fixed by problem resolution', no_fault_found: 'No fault found', duplicate: 'Duplicate', cancelled: 'Cancelled',
};
const LEVEL = ['', 'High', 'Medium', 'Low'];

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return <span className={`badge inc-${status}`}>{INCIDENT_STATUS[status]}</span>;
}

export function IncidentsPage() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const set = (k: string, v: string) => setParams((prev) => { const n = new URLSearchParams(prev); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  useEffect(() => {
    const t = setTimeout(() => set('q', q), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const { data, loading } = useApi<IncidentRow[]>(`/api/incidents?${params}`);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Incidents</h1>
          <p className="muted">Restore service first; hand recurring and major incidents to problem management.</p>
        </div>
        {user.role !== 'viewer' && <button className="btn primary" onClick={() => setCreating(true)}>Log incident</button>}
      </header>
      <div className="filters">
        <input className="search" placeholder="Search incidents…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={params.get('status') ?? 'open'} onChange={(e) => set('status', e.target.value === 'open' ? '' : e.target.value)}>
          <option value="open">Open</option>
          {Object.entries(INCIDENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          <option value="all">All</option>
        </select>
        <select value={params.get('assignee') ?? ''} onChange={(e) => set('assignee', e.target.value)}>
          <option value="">Anyone</option><option value="me">Assigned to me</option><option value="none">Unassigned</option>
        </select>
        <label className="check"><input type="checkbox" checked={params.get('major') === 'true'} onChange={(e) => set('major', e.target.checked ? 'true' : '')} /> Major only</label>
      </div>
      <section className={`card flush ${loading ? 'is-loading' : ''}`}>
        {data?.length === 0 ? <p className="empty">No incidents match.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Ref</th><th>Title</th><th>Status</th><th>Priority</th><th className="hide-sm">CIs</th><th className="hide-sm">Assignee</th><th className="hide-sm">Problem</th><th className="hide-sm">Opened</th></tr></thead>
              <tbody>
                {data?.map((i) => (
                  <tr key={i.id}>
                    <td className="mono nowrap"><Link to={`/incidents/${i.ref}`}>{i.ref}</Link></td>
                    <td className="title-cell"><Link to={`/incidents/${i.ref}`}>{i.title}</Link> {i.is_major && <MajorBadge />}</td>
                    <td><IncidentStatusBadge status={i.status} /></td>
                    <td><PriorityBadge priority={i.priority} /></td>
                    <td className="hide-sm small">{i.cis?.join(', ') ?? '–'}</td>
                    <td className="hide-sm muted">{i.assignee ?? (i.assignment_group || '–')}</td>
                    <td className="hide-sm mono small">{i.problem_ref ? <Link to={`/problems/${i.problem_ref}`}>{i.problem_ref}</Link> : '–'}</td>
                    <td className="hide-sm muted nowrap" title={formatDate(i.created_at)}>{relativeTime(i.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {creating && <NewIncident onClose={() => setCreating(false)} onDone={(ref) => navigate(`/incidents/${ref}`)} />}
    </>
  );
}

function NewIncident({ onClose, onDone }: { onClose: () => void; onDone: (ref: string) => void }) {
  const { meta } = useSession();
  const [form, setForm] = useState({ title: '', description: '', impact: 3, urgency: 3, category_id: '', assignee_id: '', assignment_group: '', reporter: '', cis: '' });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const created = await api.post<Incident>('/api/incidents', {
        title: form.title, description: form.description, impact: Number(form.impact), urgency: Number(form.urgency),
        category_id: form.category_id ? Number(form.category_id) : null, assignee_id: form.assignee_id ? Number(form.assignee_id) : null,
        assignment_group: form.assignment_group, reporter: form.reporter,
        cis: form.cis.split(/[\s,]+/).map((c) => c.trim()).filter(Boolean),
      });
      onDone(created.ref);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title="Log an incident" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="full">What is wrong?<input required autoFocus placeholder="As the user experiences it, e.g. Checkout times out" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        <label className="full">Description<textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label>Impact<select value={form.impact} onChange={(e) => setForm({ ...form, impact: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n} – {LEVEL[n]}</option>)}</select></label>
        <label>Urgency<select value={form.urgency} onChange={(e) => setForm({ ...form, urgency: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n} – {LEVEL[n]}</option>)}</select></label>
        <label>Category<select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}><option value="">–</option>{meta.categories.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Assignee<select value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}><option value="">–</option>{meta.assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></label>
        <label>Assignment group<input value={form.assignment_group} onChange={(e) => setForm({ ...form, assignment_group: e.target.value })} /></label>
        <label>Reported by<input value={form.reporter} onChange={(e) => setForm({ ...form, reporter: e.target.value })} /></label>
        <label className="full">Affected CIs <span className="muted small">(refs, e.g. CI000012 SVC000003; you can add more later)</span><input value={form.cis} onChange={(e) => setForm({ ...form, cis: e.target.value })} /></label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Log incident</button></div>
      </form>
    </Modal>
  );
}

export function IncidentPage() {
  const { ref } = useParams();
  const { user, meta } = useSession();
  const navigate = useNavigate();
  const { data: i, setData, error } = useApi<Incident>(`/api/incidents/${ref}`);
  const [note, setNote] = useState('');
  const [noteKind, setNoteKind] = useState<'comment' | 'communication'>('comment');
  const [resolving, setResolving] = useState(false);
  const [problemRef, setProblemRef] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  if (error) return <div className="error">{error}</div>;
  if (!i) return null;
  const editable = user.role !== 'viewer' && i.status !== 'closed';
  const manager = user.role === 'admin' || user.role === 'problem_manager';
  const run = async (fn: () => Promise<Incident>) => {
    setActionError(null);
    try {
      setData(await fn());
      return true;
    } catch (err) {
      setActionError((err as Error).message);
      return false;
    }
  };
  const path = `/api/incidents/${i.ref}`;
  const go = (body: object) => run(() => api.post(`${path}/transition`, body));
  const save = (fields: object) => run(() => api.patch(path, { ...fields, base: Object.fromEntries(Object.keys(fields).map((k) => [k, (i as any)[k]])) }));
  const hold = async () => {
    const reason = window.prompt('Why is it on hold? (e.g. waiting for the customer or a supplier)');
    if (reason?.trim()) await go({ to: 'on_hold', hold_reason: reason.trim() });
  };

  return (
    <>
      <header className="problem-head">
        <div className="crumbs"><Link to="/incidents">Incidents</Link> / <span className="mono">{i.ref}</span></div>
        <h1>{i.title}</h1>
        <div className="badges">
          <IncidentStatusBadge status={i.status} />
          <PriorityBadge priority={i.priority} />
          {i.is_major && <MajorBadge />}
          <span className="muted small">Opened {relativeTime(i.created_at)}{i.source !== 'user' ? ` via ${i.source}` : ''}{i.reopen_count ? ` · reopened ${i.reopen_count}×` : ''}</span>
        </div>
        {editable && (
          <div className="transitions">
            {i.status === 'new' && <button className="btn primary" onClick={() => go({ to: 'in_progress' })}>Start work</button>}
            {i.status === 'on_hold' && <button className="btn primary" onClick={() => go({ to: 'in_progress' })}>Resume</button>}
            {['new', 'in_progress'].includes(i.status) && <button className="btn" onClick={hold}>Put on hold</button>}
            {['new', 'in_progress', 'on_hold'].includes(i.status) && <button className="btn primary" onClick={() => setResolving(true)}>Resolve</button>}
            {i.status === 'resolved' && <button className="btn primary" onClick={() => go({ to: 'closed' })}>Close</button>}
            {i.status === 'resolved' && <button className="btn" onClick={() => go({ to: 'in_progress', comment: 'Reopened: the issue came back' })}>Reopen</button>}
            {manager && <button className="btn" onClick={() => save({ is_major: !i.is_major })}>{i.is_major ? 'Stand down major incident' : 'Declare major incident'}</button>}
          </div>
        )}
        {actionError && <div className="error">{actionError}</div>}
      </header>

      {i.known_errors.length > 0 && !['resolved', 'closed'].includes(i.status) && (
        <section className="card known-errors-card">
          <h2>Known error{i.known_errors.length > 1 ? 's' : ''} on the affected CIs</h2>
          {i.known_errors.map((k) => (
            <div key={k.ref} className="ke">
              <div><Link to={`/problems/${k.ref}`} className="mono">{k.ref}</Link> <strong>{k.title}</strong> <span className="muted small">on {k.ci_name}</span></div>
              {k.workaround ? <div className="workaround"><span className="muted small">Workaround</span><Markdown text={k.workaround} /></div> : <p className="muted small">No workaround documented.</p>}
              {editable && !i.problem_ref && <button className="btn small" onClick={() => run(() => api.put(`${path}/problem`, { problem: k.ref }))}>Link to {k.ref}</button>}
            </div>
          ))}
        </section>
      )}

      <div className="problem-grid">
        <div className="problem-main">
          <GuidePanel guidance={i.next_steps as Guidance} />
          <section className="card">
            <h2>Description</h2>
            {i.description ? <Markdown text={i.description} /> : <p className="placeholder">No description.</p>}
          </section>
          {(i.status === 'resolved' || i.status === 'closed') && (
            <section className="card">
              <h2>Resolution <span className="tag">{RESOLUTION[i.resolution_code ?? ''] ?? i.resolution_code}</span></h2>
              <Markdown text={i.resolution || '–'} />
            </section>
          )}
          {i.status === 'on_hold' && <p className="warn-box">On hold: {i.hold_reason}</p>}
          <section className="card">
            <h2>Work notes &amp; history</h2>
            {editable && (
              <form className="comment-form" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post(`${path}/comments`, { body: note, kind: noteKind }))) setNote(''); }}>
                <textarea rows={2} placeholder={noteKind === 'communication' ? 'Stakeholder update: what is affected, what we are doing, next update at…' : 'Add a work note'} value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="actions">
                  {i.is_major && (
                    <select value={noteKind} onChange={(e) => setNoteKind(e.target.value as 'comment')} aria-label="Kind of note">
                      <option value="comment">Work note</option><option value="communication">Communication update</option>
                    </select>
                  )}
                  <button className="btn primary" disabled={!note.trim()}>Add</button>
                </div>
              </form>
            )}
            <ul className="activity">
              {i.activity.map((a) => (
                <li key={a.id} className={a.kind === 'communication' ? 'communication' : ''}>
                  <div className="activity-head">
                    <strong>{a.user_name ?? 'System'}</strong>{' '}
                    {a.kind === 'comment' ? 'added a note' : a.kind === 'communication' ? 'posted a communication update' : a.kind === 'status' ? `moved it from ${INCIDENT_STATUS[a.data.from as IncidentStatus]} to ${INCIDENT_STATUS[a.data.to as IncidentStatus]}` : a.body}
                    {(a.channel === 'mcp' || a.channel === 'api') && <span className="tag channel">via {a.channel.toUpperCase()}</span>}
                    <time title={formatDate(a.created_at)}>{relativeTime(a.created_at)}</time>
                  </div>
                  {(a.kind === 'comment' || a.kind === 'communication' || (a.kind === 'status' && a.body)) && <Markdown text={a.body} className="activity-body" />}
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside className="problem-side">
          <section className="card">
            <h2>Details</h2>
            <dl className="kv details">
              <dt>Impact</dt>
              <dd>{editable ? <select value={i.impact} onChange={(e) => save({ impact: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n} – {LEVEL[n]}</option>)}</select> : LEVEL[i.impact]}</dd>
              <dt>Urgency</dt>
              <dd>{editable ? <select value={i.urgency} onChange={(e) => save({ urgency: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n} – {LEVEL[n]}</option>)}</select> : LEVEL[i.urgency]}</dd>
              <dt>Assignee</dt>
              <dd>{editable ? <select value={i.assignee_id ?? ''} onChange={(e) => save({ assignee_id: e.target.value ? Number(e.target.value) : null })}><option value="">–</option>{meta.assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select> : i.assignee ?? '–'}</dd>
              <dt>Group</dt><dd>{i.assignment_group || '–'}</dd>
              <dt>Category</dt>
              <dd>{editable ? <select value={i.category_id ?? ''} onChange={(e) => save({ category_id: e.target.value ? Number(e.target.value) : null })}><option value="">–</option>{meta.categories.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select> : i.category ?? '–'}</dd>
              <dt>Reported by</dt><dd>{i.reporter || '–'}</dd>
              <dt>Responded</dt><dd>{i.responded_at ? formatDate(i.responded_at) : '–'}</dd>
              <dt>Resolved</dt><dd>{i.resolved_at ? formatDate(i.resolved_at) : '–'}</dd>
            </dl>
          </section>
          <AffectedCisPanel record={i} basePath={path} editable={editable} onChange={setData} />
          <section className="card">
            <h2>Problem</h2>
            {i.problem_ref ? (
              <p><Link to={`/problems/${i.problem_ref}`} className="mono">{i.problem_ref}</Link> {i.problem_title} <span className="muted small">{i.problem_status?.replace('_', ' ')}</span></p>
            ) : <p className="placeholder">Not linked. Recurring and major incidents need a problem record to find the root cause.</p>}
            {editable && (
              <div className="rel-form">
                {!i.problem_ref && <button className="btn" onClick={async () => { const p = await api.post<{ ref: string }>(`${path}/problem`, {}).catch((err) => { setActionError(err.message); return null; }); if (p) navigate(`/problems/${p.ref}`); }}>Create problem</button>}
                <input placeholder="PRB…" value={problemRef} onChange={(e) => setProblemRef(e.target.value)} aria-label="Problem ref" />
                <button className="btn" disabled={!problemRef.trim()} onClick={() => run(() => api.put(`${path}/problem`, { problem: problemRef.trim() })).then(() => setProblemRef(''))}>{i.problem_ref ? 'Change' : 'Link'}</button>
                {i.problem_ref && <button className="btn-link" onClick={() => run(() => api.put(`${path}/problem`, { problem: '' }))}>Unlink</button>}
              </div>
            )}
          </section>
          {i.links.length > 0 && (
            <section className="card">
              <h2>Linked records</h2>
              <ul className="plain-list">{i.links.map((l) => <li key={l.id}><span className="tag">{l.kind}</span> {l.url ? <a href={l.url} target="_blank" rel="noreferrer noopener">{l.reference} ↗</a> : l.reference} <span className="muted small">{l.system}</span></li>)}</ul>
            </section>
          )}
        </aside>
      </div>
      {resolving && <ResolveModal incident={i} onClose={() => setResolving(false)} onDone={(n) => { setData(n); setResolving(false); }} />}
    </>
  );
}

function ResolveModal({ incident: i, onClose, onDone }: { incident: Incident; onClose: () => void; onDone: (i: Incident) => void }) {
  const [code, setCode] = useState(i.known_errors.length ? 'workaround' : 'fixed');
  const [resolution, setResolution] = useState(i.known_errors[0]?.workaround && code === 'workaround' ? `Applied the workaround from ${i.known_errors[0].ref}.` : '');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Resolve ${i.ref}`} onClose={onClose}>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        try { onDone(await api.post<Incident>(`/api/incidents/${i.ref}/transition`, { to: 'resolved', resolution_code: code, resolution })); } catch (err) { setError((err as Error).message); }
      }}>
        <label className="full">Resolution code<select value={code} onChange={(e) => setCode(e.target.value)}>{Object.entries(RESOLUTION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="full">How was service restored?<textarea rows={4} required={!['duplicate', 'cancelled'].includes(code)} value={resolution} onChange={(e) => setResolution(e.target.value)} /></label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Resolve</button></div>
      </form>
    </Modal>
  );
}
