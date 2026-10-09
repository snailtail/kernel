import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, type User } from '../api';
import { GroupsPage, ImpactSection, RelationshipsSection, type Relationship } from '../components/CmdbGraph';
import { Markdown } from '../components/Markdown';
import { SeverityBadge } from '../components/Badges';
import { Modal } from '../components/Modal';
import { Term } from '../components/Glossary';
import { formatDate, relativeTime } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';

export interface CiType { name: string; label: string; class: 'ci' | 'service'; attributes: { key: string; label: string; type: 'string' | 'number' }[]; active: boolean }
interface Source { id: number; source_system: string; source_id: string; source_url: string; first_seen_at: string; last_seen_at: string }
interface CiLink { id: number; kind: string; reference: string; system: string; url: string; note: string }
interface CiActivity { id: number; kind: string; body: string; data: any; channel: string; created_at: string; user_name: string | null }
export interface Ci {
  id: number; ref: string; type: 'ci' | 'service'; class: 'ci' | 'service'; name: string; ci_type: string; type_label: string; status: string;
  environment: string; criticality: number; owner_id: number | null; owner: string | null; team: string; description: string;
  tags: string[]; attributes: Record<string, unknown>; created_at: string; updated_at: string; last_seen_at: string | null;
  source_systems: string[] | null; url: string;
}
interface CiProblem { ref: string; title: string; status: string; priority: number; workaround?: string; workaround_effectiveness?: string | null; ec_decision?: string | null }
interface CiDetail extends Ci { alerts: { id: number; source: string; check_key: string; severity: string; status: string; count: number; flap_count: number; last_seen: string; suppressed: string; incident_ref: string | null }[]; maintenance_windows: { id: number; starts_at: string; ends_at: string; reason: string }[]; incidents: { ref: string; title: string; status: string; priority: number }[]; problems: CiProblem[]; known_errors: CiProblem[]; recent_records: { system: string; kind: string; reference: string; summary: string; occurred_at: string; linked: boolean }[]; sources: Source[]; links: CiLink[]; activity: CiActivity[]; relationships: Relationship[]; groups: { id: number; name: string; purpose: string; membership: string }[] }

const STATUSES = ['planned', 'active', 'maintenance', 'retired', 'missing'];
const CRITICALITY: Record<number, string> = { 1: 'Business critical', 2: 'High', 3: 'Medium', 4: 'Low' };
const canManage = (u: User) => u.role === 'admin' || u.role === 'problem_manager';

export function CiStatus({ status }: { status: string }) {
  return <span className={`badge ci-status ci-${status}`}>{status}</span>;
}

export function CmdbListPage() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const { data: types } = useApi<CiType[]>('/api/ci-types');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const set = (k: string, v: string) => setParams((prev) => { const n = new URLSearchParams(prev); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  useEffect(() => {
    const t = setTimeout(() => set('q', q), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const { data, loading } = useApi<Ci[]>(`/api/cis?${params}`);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Configuration items</h1>
          <p className="muted">What we operate, as pointers to where it really lives. Services are listed first.</p>
        </div>
        <div className="head-actions">
          <Link className="btn" to="/services">Service catalogue</Link>
          <Link className="btn" to="/cis/groups">Groups</Link>
          {canManage(user) && <button className="btn primary" onClick={() => setCreating(true)}>Add CI or service</button>}
        </div>
      </header>
      <div className="filters">
        <input className="search" placeholder="Search name, tag, IP, FQDN…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={params.get('class') ?? 'all'} onChange={(e) => set('class', e.target.value === 'all' ? '' : e.target.value)}>
          <option value="all">CIs and services</option><option value="ci">CIs</option><option value="service">Services</option>
        </select>
        <select value={params.get('type') ?? ''} onChange={(e) => set('type', e.target.value)}>
          <option value="">Any type</option>
          {types?.map((t) => <option key={t.name} value={t.name}>{t.label}</option>)}
        </select>
        <select value={params.get('status') ?? 'current'} onChange={(e) => set('status', e.target.value === 'current' ? '' : e.target.value)}>
          <option value="current">Not retired</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          <option value="all">All</option>
        </select>
        <select value={params.get('environment') ?? ''} onChange={(e) => set('environment', e.target.value)}>
          <option value="">Any environment</option>{['prod', 'test', 'dev', 'other'].map((e) => <option key={e}>{e}</option>)}
        </select>
      </div>
      <section className={`card flush ${loading ? 'is-loading' : ''}`}>
        {data?.length === 0 ? <p className="empty">No configuration items match.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Ref</th><th>Name</th><th>Type</th><th>Status</th><th className="hide-sm">Env</th><th className="hide-sm">Criticality</th><th className="hide-sm">Team</th><th className="hide-sm">Sources</th><th className="hide-sm">Last seen</th></tr></thead>
              <tbody>
                {data?.map((c) => (
                  <tr key={c.id}>
                    <td className="mono nowrap"><Link to={`/cis/${c.ref}`}>{c.ref}</Link></td>
                    <td className="title-cell"><Link to={`/cis/${c.ref}`}>{c.name}</Link></td>
                    <td className="muted">{c.type_label}</td>
                    <td><CiStatus status={c.status} /></td>
                    <td className="hide-sm">{c.environment}</td>
                    <td className="hide-sm"><span className={`crit crit-${c.criticality}`}>{CRITICALITY[c.criticality]}</span></td>
                    <td className="hide-sm muted">{c.team || '–'}</td>
                    <td className="hide-sm small">{c.source_systems?.join(', ') ?? 'manual'}</td>
                    <td className="hide-sm muted nowrap">{c.last_seen_at ? relativeTime(c.last_seen_at) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {creating && types && <CiModal types={types} onClose={() => setCreating(false)} onDone={(ci) => navigate(`/cis/${ci.ref}`)} />}
    </>
  );
}

export function CiPage() {
  const { ref } = useParams();
  const { user } = useSession();
  const { data: ci, setData, error } = useApi<CiDetail>(`/api/cis/${ref}`);
  const { data: types } = useApi<CiType[]>('/api/ci-types');
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  if (error) return <div className="error">{error}</div>;
  if (!ci) return null;
  const type = types?.find((t) => t.name === ci.ci_type);
  const manage = canManage(user);
  const annotate = user.role !== 'viewer';
  const run = async (fn: () => Promise<CiDetail>) => {
    setActionError(null);
    try {
      setData(await fn());
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  return (
    <>
      <header className="problem-head">
        <div className="crumbs"><Link to="/cis">Configuration items</Link> / <span className="mono">{ci.ref}</span></div>
        <h1>{ci.name}</h1>
        <div className="badges">
          <CiStatus status={ci.status} />
          <span className="badge neutral">{ci.type_label}</span>
          <span className="badge neutral">{ci.environment}</span>
          <span className={`crit crit-${ci.criticality}`}>{CRITICALITY[ci.criticality]}</span>
          {ci.tags.map((t) => <span key={t} className="tag">{t}</span>)}
        </div>
        {manage && (
          <div className="ci-head-actions">
            <button className="btn" onClick={() => setEditing(true)}>Edit</button>
            <select value={ci.status} aria-label="Status" onChange={(e) => run(() => api.post(`/api/cis/${ci.ref}/transition`, { to: e.target.value }))}>
              {STATUSES.map((s) => <option key={s} value={s}>Status: {s}</option>)}
            </select>
          </div>
        )}
        {actionError && <div className="error">{actionError}</div>}
      </header>

      <div className="problem-grid">
        <div className="problem-main">
          {ci.description && <section className="card"><h2>Description</h2><Markdown text={ci.description} /></section>}
          <section className="card">
            <h2>Attributes</h2>
            <dl className="kv ci-attrs">
              {(type?.attributes ?? []).map((a) => (<Fragment key={a.key}><dt>{a.label}</dt><dd className="mono">{String(ci.attributes[a.key] ?? '–')}</dd></Fragment>))}
              <dt>Owner</dt><dd>{ci.owner ?? '–'}</dd>
              <dt>Team</dt><dd>{ci.team || '–'}</dd>
            </dl>
          </section>
          {ci.known_errors.length > 0 && (
            <section className="card known-errors-card">
              <h2>Known errors on this {ci.class === 'service' ? 'service' : 'CI'} <span className="count">{ci.known_errors.length}</span></h2>
              {ci.known_errors.map((k) => (
                <div key={k.ref} className="ke">
                  <div><Link to={`/problems/${k.ref}`} className="mono">{k.ref}</Link> <strong>{k.title}</strong>{k.workaround_effectiveness && <span className="muted small"> · workaround {k.workaround_effectiveness}</span>}</div>
                  {k.workaround ? <div className="workaround"><span className="muted small">Workaround</span><Markdown text={k.workaround} /></div> : <p className="muted small">No workaround documented.</p>}
                </div>
              ))}
            </section>
          )}
          {(ci.problems.length > 0 || ci.recent_records.length > 0) && (
            <section className="card">
              <h2>Problems &amp; recent records</h2>
              {ci.problems.length > 0 && (
                <ul className="work-list">
                  {ci.problems.map((p) => (
                    <li key={p.ref}><div><Link to={`/problems/${p.ref}`} className="mono">{p.ref}</Link> {p.title}</div><span className="work-meta"><span className="tag">P{p.priority}</span><span className="muted small">{p.status.replace('_', ' ')}</span></span></li>
                  ))}
                </ul>
              )}
              {ci.recent_records.length > 0 && (
                <ul className="work-list">
                  {ci.recent_records.map((r) => (
                    <li key={`${r.system}-${r.kind}-${r.reference}`}>
                      <div><span className="tag">{r.kind}</span> <span className="mono">{r.reference}</span> <span className="muted small">{r.system}</span> {r.summary}</div>
                      <span className="work-meta"><span className="muted small">{r.linked ? 'linked' : 'not linked'} · {relativeTime(r.occurred_at)}</span></span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {(ci.alerts.length > 0 || ci.incidents.length > 0) && (
            <section className="card">
              <h2>Alerts &amp; incidents</h2>
              {ci.maintenance_windows.map((w) => <p key={w.id} className="hint-box">Maintenance {formatDate(w.starts_at)} – {formatDate(w.ends_at)}{w.reason && `: ${w.reason}`}. Alerts are suppressed.</p>)}
              <ul className="work-list">
                {ci.incidents.map((i) => (
                  <li key={i.ref}><div><Link to={`/incidents/${i.ref}`} className="mono">{i.ref}</Link> {i.title}</div><span className="work-meta"><span className="tag">P{i.priority}</span><span className="muted small">{i.status.replace('_', ' ')}</span></span></li>
                ))}
                {ci.alerts.map((a) => (
                  <li key={`a${a.id}`}>
                    <div><SeverityBadge severity={a.status === 'closed' ? 'clear' : a.severity} /> <span className="mono small">{a.check_key}</span> <span className="muted small">{a.source} ×{a.count}{a.suppressed ? ' · suppressed' : ''}</span></div>
                    <span className="work-meta">{a.incident_ref && <Link to={`/incidents/${a.incident_ref}`} className="mono small">{a.incident_ref}</Link>}<span className="muted small">{relativeTime(a.last_seen)}</span></span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <ImpactSection key={ci.ref} ciRef={ci.ref} isService={ci.class === 'service'} />
          <RelationshipsSection ciRef={ci.ref} relationships={ci.relationships} editable={manage} onChange={setData} />
          <section className="card">
            <h2>Notes &amp; history</h2>
            {annotate && (
              <form className="comment-form" onSubmit={(e) => { e.preventDefault(); run(() => api.post(`/api/cis/${ci.ref}/comments`, { body: note })).then(() => setNote('')); }}>
                <textarea rows={2} placeholder="Add a note about this CI" value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="actions"><button className="btn primary" disabled={!note.trim()}>Add note</button></div>
              </form>
            )}
            <ul className="activity">
              {ci.activity.map((a) => (
                <li key={a.id}>
                  <div className="activity-head">
                    <strong>{a.user_name ?? 'System'}</strong> {a.kind === 'comment' ? 'added a note' : a.body || a.kind}
                    {(a.channel === 'mcp' || a.channel === 'api') && <span className="tag channel">via {a.channel.toUpperCase()}</span>}
                    <time title={formatDate(a.created_at)}>{relativeTime(a.created_at)}</time>
                  </div>
                  {a.kind === 'comment' && <Markdown text={a.body} className="activity-body" />}
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside className="problem-side">
          <section className="card">
            <h2>Where it lives</h2>
            {ci.sources.length === 0 ? <p className="placeholder">Added manually; no source system.</p> : (
              <ul className="sources">
                {ci.sources.map((s) => (
                  <li key={s.id}>
                    {s.source_url ? <a className="btn small" href={s.source_url} target="_blank" rel="noreferrer noopener">Open in {s.source_system} ↗</a> : <strong>{s.source_system}</strong>}
                    <div className="muted small mono">{s.source_id}</div>
                    <div className="muted small">Seen {relativeTime(s.last_seen_at)} · first {formatDate(s.first_seen_at)}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <CiLinks ci={ci} editable={annotate} onChange={setData} />
          {ci.groups.length > 0 && (
            <section className="card">
              <h2>Groups</h2>
              <ul className="plain-list">
                {ci.groups.map((g) => <li key={g.id}><Link to={`/cis/groups?open=${g.id}`}>{g.name}</Link> <span className="muted small">{g.purpose}{g.membership === 'rule' ? ' · by rule' : ''}</span></li>)}
              </ul>
            </section>
          )}
        </aside>
      </div>
      {editing && types && <CiModal types={types} ci={ci} onClose={() => setEditing(false)} onDone={(n) => { setData(n as CiDetail); setEditing(false); }} />}
    </>
  );
}

function CiLinks({ ci, editable, onChange }: { ci: CiDetail; editable: boolean; onChange: (c: CiDetail) => void }) {
  const [form, setForm] = useState({ kind: 'incident', reference: '', system: '', url: '' });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onChange(await api.post<CiDetail>(`/api/cis/${ci.ref}/links`, form));
      setAdding(false);
      setForm({ ...form, reference: '', url: '' });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card links">
      <div className="section-head"><h2>Linked records</h2>{editable && !adding && <button className="btn-link" onClick={() => setAdding(true)}>+ Link</button>}</div>
      {adding && (
        <form className="link-form" onSubmit={add}>
          <div className="row">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{['incident', 'event', 'change', 'document'].map((k) => <option key={k}>{k}</option>)}</select>
            <input required placeholder="Reference" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </div>
          <input placeholder="System" value={form.system} onChange={(e) => setForm({ ...form, system: e.target.value })} />
          <input type="url" placeholder="https://…" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <div className="actions"><button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn primary">Add link</button></div>
        </form>
      )}
      {error && <div className="error">{error}</div>}
      {ci.links.length === 0 && !adding && <p className="placeholder">Nothing linked.</p>}
      <ul>
        {ci.links.map((l) => (
          <li key={l.id} className="link-main">
            <span className="tag">{l.kind}</span>
            {l.kind === 'problem' ? <Link to={`/problems/${l.reference}`} className="mono">{l.reference}</Link> : l.url ? <a href={l.url} target="_blank" rel="noreferrer noopener" className="mono">{l.reference} ↗</a> : <span className="mono">{l.reference}</span>}
            {l.system && <span className="muted small">{l.system}</span>}
            {editable && <button className="btn-icon small" aria-label="Remove link" onClick={async () => onChange(await api.del<CiDetail>(`/api/cis/${ci.ref}/links/${l.id}`))}>×</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CiModal({ types, ci, onClose, onDone }: { types: CiType[]; ci?: Ci; onClose: () => void; onDone: (ci: Ci) => void }) {
  const { meta } = useSession();
  const [form, setForm] = useState({
    name: ci?.name ?? '', ci_type: ci?.ci_type ?? 'virtual_machine', environment: ci?.environment ?? 'prod', criticality: ci?.criticality ?? 3,
    team: ci?.team ?? '', owner_id: ci?.owner_id ? String(ci.owner_id) : '', tags: (ci?.tags ?? []).join(', '), description: ci?.description ?? '',
    attributes: Object.fromEntries(Object.entries(ci?.attributes ?? {}).map(([k, v]) => [k, String(v)])) as Record<string, string>,
    source_system: '', source_id: '', source_url: '',
    sla_id: (ci as any)?.sla_id ? String((ci as any).sla_id) : '', user_description: (ci as any)?.user_description ?? '', how_to_get_help: (ci as any)?.how_to_get_help ?? '', in_catalogue: !!(ci as any)?.in_catalogue,
  });
  const { data: slas } = useApi<{ id: number; name: string }[]>('/api/slas');
  const [error, setError] = useState<string | null>(null);
  const type = types.find((t) => t.name === form.ci_type);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      name: form.name, ci_type: form.ci_type, environment: form.environment, criticality: Number(form.criticality), team: form.team,
      owner_id: form.owner_id ? Number(form.owner_id) : null, description: form.description,
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean), attributes: form.attributes,
      ...(type?.class === 'service' ? { sla_id: form.sla_id ? Number(form.sla_id) : null, user_description: form.user_description, how_to_get_help: form.how_to_get_help, in_catalogue: form.in_catalogue } : {}),
      ...(!ci && form.source_system && form.source_id ? { source: { system: form.source_system, id: form.source_id, url: form.source_url } } : {}),
    };
    try {
      onDone(ci ? await api.patch<Ci>(`/api/cis/${ci.ref}`, body) : await api.post<Ci>('/api/cis', body));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title={ci ? `Edit ${ci.ref}` : 'Add a CI or service'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="full">Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Type
          <select value={form.ci_type} onChange={(e) => setForm({ ...form, ci_type: e.target.value })}>
            <optgroup label="Services">{types.filter((t) => t.class === 'service' && t.active && (!ci || ci.class === 'service')).map((t) => <option key={t.name} value={t.name}>{t.label}</option>)}</optgroup>
            <optgroup label="Configuration items">{types.filter((t) => t.class === 'ci' && t.active && (!ci || ci.class === 'ci')).map((t) => <option key={t.name} value={t.name}>{t.label}</option>)}</optgroup>
          </select>
        </label>
        <label>Environment<select value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}>{['prod', 'test', 'dev', 'other'].map((x) => <option key={x}>{x}</option>)}</select></label>
        <label><Term id="criticality" /><select value={form.criticality} onChange={(e) => setForm({ ...form, criticality: Number(e.target.value) })}>{[1, 2, 3, 4].map((c) => <option key={c} value={c}>{c} – {CRITICALITY[c]}</option>)}</select></label>
        <label>Owner<select value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })}><option value="">–</option>{meta.assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></label>
        <label>Team<input value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })} /></label>
        <label>Tags<input value={form.tags} placeholder="app=payroll, pci" onChange={(e) => setForm({ ...form, tags: e.target.value })} /></label>
        {type?.attributes.map((a) => (
          <label key={a.key}>{a.label}<input type={a.type === 'number' ? 'number' : 'text'} value={form.attributes[a.key] ?? ''} onChange={(e) => setForm({ ...form, attributes: { ...form.attributes, [a.key]: e.target.value } })} /></label>
        ))}
        <label className="full">Description<textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        {type?.class === 'service' && (
          <fieldset className="full source-fields">
            <legend>Service catalogue</legend>
            <label>SLA<select value={form.sla_id} onChange={(e) => setForm({ ...form, sla_id: e.target.value })}><option value="">Default</option>{slas?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label>For users<textarea rows={2} placeholder="What the service is, in plain words" value={form.user_description} onChange={(e) => setForm({ ...form, user_description: e.target.value })} /></label>
            <label>How to get help<textarea rows={2} value={form.how_to_get_help} onChange={(e) => setForm({ ...form, how_to_get_help: e.target.value })} /></label>
            <label className="check"><input type="checkbox" checked={form.in_catalogue} onChange={(e) => setForm({ ...form, in_catalogue: e.target.checked })} /> Show in the service catalogue</label>
          </fieldset>
        )}
        {!ci && (
          <fieldset className="full source-fields">
            <legend>Source <span className="muted small">(optional: where it lives)</span></legend>
            <input placeholder="System, e.g. vCenter" value={form.source_system} onChange={(e) => setForm({ ...form, source_system: e.target.value })} />
            <input placeholder="Id in that system" value={form.source_id} onChange={(e) => setForm({ ...form, source_id: e.target.value })} />
            <input type="url" placeholder="https://… link to it" value={form.source_url} onChange={(e) => setForm({ ...form, source_url: e.target.value })} />
          </fieldset>
        )}
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

export function CiGroupsPage() {
  const { user } = useSession();
  return <GroupsPage canManage={canManage(user)} />;
}
