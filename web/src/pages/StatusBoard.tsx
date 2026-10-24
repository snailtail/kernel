import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { askReason } from '../components/Ask';
import { Modal } from '../components/Modal';
import { formatDate, relativeTime } from '../format';
import { useApi } from '../hooks';
import { canEdit, isManager, useSession } from '../session';

type Status = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance';
interface Service {
  id: number; ref: string; name: string; criticality: number; status: Status; suggested: Status; incidents: { ref: string; priority: number; major: boolean }[];
  public: boolean; public_name: string; public_description: string; public_status: Status; updated_at: string | null; updated_by: string | null; following: boolean;
}
interface Update {
  id: number; phase: string; status: Status | null; message: string; public: boolean; retracted_at: string | null; created_at: string; incident: string | null; author: string | null; services: string[] | null;
  /** Mail to people outside: subscribers and organisation contacts. */
  outside: { sent: number; pending: number; failed: number } | null;
}
interface Board { services: Service[]; updates: Update[]; planned_maintenance: { ref: string; title: string; planned_start: string; planned_end: string; service: string }[]; settings: { public_enabled: boolean; title: string; sign_up: boolean } }

export const STATUS_LABEL: Record<Status, string> = { operational: 'Operational', degraded: 'Degraded', partial_outage: 'Partial outage', major_outage: 'Major outage', maintenance: 'Maintenance' };
const PHASES = ['investigating', 'identified', 'monitoring', 'resolved', 'maintenance'] as const;
/** Starting points for quick, plain updates (customers read the public ones). */
const TEMPLATES: Record<(typeof PHASES)[number], string> = {
  investigating: 'We are investigating reports of problems with {service}. Next update within 30 minutes.',
  identified: 'We have found the cause and are working on a fix. Next update within 30 minutes.',
  monitoring: 'A fix is in place and we are monitoring the results.',
  resolved: '{service} is working normally again. We apologise for the disruption.',
  maintenance: 'Planned maintenance on {service}. Some functions may be unavailable during the window.',
};

export function StatusPill({ status }: { status: Status }) {
  return <span className={`status-pill sp-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function StatusBoardPage() {
  const { user } = useSession();
  const { data, setData } = useApi<Board>('/api/status');
  const [composing, setComposing] = useState<string[] | null>(null);
  const [publishing, setPublishing] = useState<Service | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const manager = isManager(user);
  const run = async (fn: () => Promise<Board>) => {
    setError(null);
    try {
      setData(await fn());
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Service status</h1>
          <p className="muted">Kernel suggests a status from open incidents, maintenance and changes; you set it and keep people informed.{data.settings.public_enabled ? ' The public page shows only what a manager publishes.' : ''}</p>
        </div>
        <div className="head-actions">
          {data.settings.public_enabled && <a className="btn" href="/status" target="_blank" rel="noreferrer">Public page</a>}
          {canEdit(user) && <button className="btn primary" onClick={() => setComposing([])}>Post an update</button>}
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      <section className="card flush">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Service</th><th>Status</th><th>Kernel suggests</th>{data.settings.public_enabled && <th className="hide-sm">Public</th>}<th /></tr></thead>
            <tbody>
              {data.services.map((s) => (
                <tr key={s.id}>
                  <td className="title-cell"><Link to={`/cis/${s.ref}`}>{s.name}</Link></td>
                  <td>
                    {canEdit(user)
                      ? <select value={s.status} onChange={(e) => run(() => api.put(`/api/status/${s.ref}`, { status: e.target.value }))} aria-label={`Status of ${s.name}`}>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                      : <StatusPill status={s.status} />}
                  </td>
                  <td>
                    {s.suggested !== s.status ? (
                      <span className="suggestion">
                        <StatusPill status={s.suggested} />
                        <span className="muted small"> {s.incidents.length ? `from ${s.incidents.map((i) => i.ref).join(', ')}` : s.suggested === 'maintenance' ? 'maintenance or a change in progress' : 'no open incidents'}</span>
                        {canEdit(user) && <button className="btn small" onClick={() => run(() => api.put(`/api/status/${s.ref}`, { status: s.suggested }))}>Apply</button>}
                      </span>
                    ) : <span className="muted small">–</span>}
                  </td>
                  {data.settings.public_enabled && (
                    <td className="hide-sm">
                      {s.public ? <><StatusPill status={s.public_status} /> <span className="muted small">as “{s.public_name}”</span></> : <span className="muted small">not shown</span>}
                      {manager && <button className="btn-link small" onClick={() => setPublishing(s)}>{s.public ? 'Edit' : 'Show'}</button>}
                    </td>
                  )}
                  <td>
                    <div className="row-actions">
                    <button className={`btn small${s.following ? ' active' : ''}`} aria-pressed={s.following} title={s.following ? 'You hear about its updates. Click to stop.' : 'Hear about its updates by your notification settings'}
                      onClick={() => run(async () => { await api.put(`/api/status/${s.ref}/follow`, { follow: !s.following }); return api.get<Board>('/api/status'); })}>{s.following ? 'Following' : 'Follow'}</button>
                    {canEdit(user) && <button className="btn small" onClick={() => setComposing([s.ref])}>Update</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="grid-2 wide-left">
        <section className="card">
          <h2>Updates</h2>
          {data.updates.length === 0 && <p className="placeholder">No updates yet.</p>}
          <ul className="activity">
            {data.updates.map((u) => (
              <li key={u.id} className={u.retracted_at ? 'muted' : ''}>
                <strong>{u.phase[0].toUpperCase() + u.phase.slice(1)}</strong> {u.status && <StatusPill status={u.status} />} {(u.services ?? []).join(', ')}
                {u.public && <span className="badge">public</span>}{u.retracted_at && <span className="badge">retracted</span>}
                <p>{u.message}</p>
                <span className="muted small">{u.author ?? 'System'} · {relativeTime(u.created_at)}{u.incident ? <> · <Link to={`/incidents/${u.incident}`}>{u.incident}</Link></> : null}{u.outside && (u.outside.sent || u.outside.pending || u.outside.failed) ? <> · emailed {u.outside.sent}{u.outside.pending ? `, ${u.outside.pending} queued` : ''}{u.outside.failed ? `, ${u.outside.failed} failed` : ''}</> : null}</span>{' '}
                {manager && u.public && <button className="btn-link small" onClick={async () => { const reason = await askReason('Retract the update', 'It leaves the public page and email not yet sent is stopped; it stays here, marked as retracted.'); if (reason) run(async () => { await api.post(`/api/status/updates/${u.id}/retract`, { reason }); return api.get<Board>('/api/status'); }); }}>Retract</button>}
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>Planned maintenance</h2>
          {data.planned_maintenance.length === 0 && <p className="placeholder">No changes scheduled on services in the next two weeks.</p>}
          <ul className="plain-list">
            {data.planned_maintenance.map((c) => <li key={c.ref + c.service}><Link to={`/changes/${c.ref}`} className="mono small">{c.ref}</Link> {c.service} <span className="muted small">{formatDate(c.planned_start)} – {formatDate(c.planned_end)}</span></li>)}
          </ul>
          <p className="muted small">To announce one publicly, post a public update with the phase “maintenance”.</p>
        </section>
      </div>
      {composing && <ComposeModal services={data.services} initial={composing} publicEnabled={data.settings.public_enabled && manager} onClose={() => setComposing(null)} onDone={(b) => { setData(b); setComposing(null); }} />}
      {publishing && <PublishModal service={publishing} onClose={() => setPublishing(null)} onDone={(b) => { setData(b); setPublishing(null); }} />}
    </>
  );
}

function ComposeModal({ services, initial, publicEnabled, onClose, onDone, incident }: { services: Service[]; initial: string[]; publicEnabled: boolean; onClose: () => void; onDone: (b: Board) => void; incident?: string }) {
  const [chosen, setChosen] = useState<string[]>(initial);
  const [phase, setPhase] = useState<(typeof PHASES)[number]>('investigating');
  const [status, setStatus] = useState<Status | ''>('');
  const names = services.filter((s) => chosen.includes(s.ref)).map((s) => (s.public && s.public_name) || s.name).join(', ') || 'the service';
  const [message, setMessage] = useState(TEMPLATES.investigating.replace('{service}', names));
  const [pub, setPub] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    try {
      onDone(await api.post<Board>('/api/status/updates', { services: chosen, phase, ...(status ? { status } : {}), message, public: pub, ...(incident ? { incident } : {}) }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title="Post a status update" onClose={onClose}>
      <div className="form">
        <div className="full check-grid">
          {services.map((s) => <label key={s.ref} className="check"><input type="checkbox" checked={chosen.includes(s.ref)} onChange={(e) => setChosen(e.target.checked ? [...chosen, s.ref] : chosen.filter((r) => r !== s.ref))} /> {s.name}</label>)}
        </div>
        <label>Phase<select value={phase} onChange={(e) => { const p = e.target.value as (typeof PHASES)[number]; setPhase(p); setMessage(TEMPLATES[p].replace('{service}', names)); }}>{PHASES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</select></label>
        <label>Set status<select value={status} onChange={(e) => setStatus(e.target.value as Status | '')}><option value="">Leave as is</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="full">Message<textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
        {publicEnabled && <label className="check full"><input type="checkbox" checked={pub} onChange={(e) => setPub(e.target.checked)} /> Publish <span className="muted small">(the public page, email subscribers and the contacts of organisations using these services; written for customers: no internal names, hosts or people)</span></label>}
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!chosen.length || message.trim().length < 5} onClick={submit}>Post</button></div>
      </div>
    </Modal>
  );
}

function PublishModal({ service: s, onClose, onDone }: { service: Service; onClose: () => void; onDone: (b: Board) => void }) {
  const [form, setForm] = useState<{ public: boolean; public_name: string; public_description: string }>({ public: true, public_name: s.public_name, public_description: s.public_description });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`${s.name} on the public page`} onClose={onClose}>
      <div className="form">
        <label className="check full"><input type="checkbox" checked={form.public} onChange={(e) => setForm({ ...form, public: e.target.checked })} /> Show on the public page</label>
        <label>Public name<input value={form.public_name} onChange={(e) => setForm({ ...form, public_name: e.target.value })} placeholder="What customers call it, e.g. Online shop" /></label>
        <label className="full">Description<input value={form.public_description} onChange={(e) => setForm({ ...form, public_description: e.target.value })} placeholder="e.g. Ordering and payment" /></label>
        <p className="muted small full">The internal name, CIs, hosts and incidents are never shown. Its public status changes only when you publish one.</p>
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={async () => { try { onDone(await api.put<Board>(`/api/status/${s.ref}/public`, form)); } catch (err) { setError((err as Error).message); } }}>Save</button></div>
      </div>
    </Modal>
  );
}
