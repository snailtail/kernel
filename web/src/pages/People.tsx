import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { askReason } from '../components/Ask';
import { Modal } from '../components/Modal';
import { formatDate } from '../format';
import { useApi } from '../hooks';
import { canEdit, isManager, useSession } from '../session';

interface Person {
  id: number; name: string; email: string | null; phone: string; title: string; department: string; location: string;
  organisation_id: number | null; organisation: string | null; manager_id: number | null; manager: string | null;
  is_vip: boolean; active: boolean; external_id: string | null; source: string; user_id: number | null; erased_at: string | null;
}
interface PersonPage extends Person {
  incidents: { ref: string; title: string; status: string; priority: number; created_at: string; role: string }[];
  services: { ref: string; name: string; criticality: number }[];
  owns: { ref: string; name: string; class: string; role: string }[];
}
interface Organisation { id: number; name: string; kind: 'internal' | 'customer'; description: string; active: boolean; people: number; services: { ref: string; name: string }[] }

export function PeoplePage() {
  const { user } = useSession();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [org, setOrg] = useState('');
  const [tab, setTab] = useState<'people' | 'organisations'>('people');
  const [editing, setEditing] = useState<Person | 'new' | null>(null);
  const [editingOrg, setEditingOrg] = useState<Organisation | 'new' | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const params = new URLSearchParams({ limit: '100', ...(query ? { q: query } : {}), ...(org ? { organisation_id: org } : {}) });
  const { data: people, loading } = useApi<Person[]>(`/api/people?${params}`);
  const { data: orgs, reload: reloadOrgs } = useApi<Organisation[]>('/api/organisations');
  const canWrite = canEdit(user);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>People</h1>
          <p className="muted">Contacts – callers, affected users, service owners. A contact needs no Kernel login.</p>
        </div>
        <div className="head-actions">
          {tab === 'people' && canWrite && <button className="btn primary" onClick={() => setEditing('new')}>Add contact</button>}
          {tab === 'organisations' && isManager(user) && <button className="btn primary" onClick={() => setEditingOrg('new')}>Add organisation</button>}
        </div>
      </header>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'people'} className={tab === 'people' ? 'on' : ''} onClick={() => setTab('people')}>Contacts</button>
        <button role="tab" aria-selected={tab === 'organisations'} className={tab === 'organisations' ? 'on' : ''} onClick={() => setTab('organisations')}>Organisations</button>
      </div>
      {tab === 'people' ? (
        <>
          <div className="filters">
            <input className="search" placeholder="Search name, email, department…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={org} onChange={(e) => setOrg(e.target.value)}>
              <option value="">Any organisation</option>
              {orgs?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <section className={`card flush ${loading ? 'is-loading' : ''}`}>
            {people?.length === 0 ? <p className="empty">{query ? 'No contacts match.' : 'No contacts yet. Add one here, or type a name or email in an incident’s caller field.'}</p> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Name</th><th>Email</th><th className="hide-sm">Organisation</th><th className="hide-sm">Department</th><th className="hide-sm">Title</th></tr></thead>
                  <tbody>
                    {people?.map((p) => (
                      <tr key={p.id} className={p.active ? '' : 'muted'}>
                        <td className="title-cell"><Link to={`/people/${p.id}`}>{p.name}</Link> {p.is_vip && <span className="vip">VIP</span>}</td>
                        <td>{p.email ?? '–'}</td>
                        <td className="hide-sm">{p.organisation ?? '–'}</td>
                        <td className="hide-sm muted">{p.department || '–'}</td>
                        <td className="hide-sm muted">{p.title || '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : (
        <section className="card flush">
          {orgs?.length === 0 ? <p className="empty">No organisations yet. Organisations group contacts and record which services they consume.</p> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Name</th><th>Kind</th><th>Contacts</th><th className="hide-sm">Services consumed</th><th /></tr></thead>
                <tbody>
                  {orgs?.map((o) => (
                    <tr key={o.id} className={o.active ? '' : 'muted'}>
                      <td className="title-cell">{o.name}</td>
                      <td>{o.kind}</td>
                      <td><button type="button" className="link-btn" onClick={() => { setOrg(String(o.id)); setTab('people'); }}>{o.people}</button></td>
                      <td className="hide-sm small">{o.services.map((s, n) => <span key={s.ref}>{n > 0 && ', '}<Link to={`/cis/${s.ref}`}>{s.name}</Link></span>)}{o.services.length === 0 && '–'}</td>
                      <td>{isManager(user) && <button className="btn small" onClick={() => setEditingOrg(o)}>Edit</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {editing && <PersonModal person={editing === 'new' ? undefined : editing} orgs={orgs ?? []} onClose={() => setEditing(null)} onDone={(p) => navigate(`/people/${p.id}`)} />}
      {editingOrg && <OrganisationModal org={editingOrg === 'new' ? undefined : editingOrg} onClose={() => setEditingOrg(null)} onDone={() => { setEditingOrg(null); reloadOrgs(); }} />}
    </>
  );
}

export function PersonPage() {
  const { id } = useParams();
  const { user } = useSession();
  const { data: p, error, reload } = useApi<PersonPage>(`/api/people/${id}`);
  const { data: orgs } = useApi<Organisation[]>('/api/organisations');
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  if (error) return <div className="error">{error}</div>;
  if (!p) return null;
  const erase = async () => {
    const reason = await askReason(`Erase ${p.name}`, 'The contact is anonymised: name, email, phone and other details are removed. Incidents keep the reference as "Erased person". This cannot be undone.', { danger: true, confirmLabel: 'Erase contact' });
    if (!reason) return;
    try {
      await api.post(`/api/people/${p.id}/erase`, { reason });
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };
  return (
    <>
      <header className="problem-head">
        <div className="crumbs"><Link to="/people">People</Link> / <span>#{p.id}</span></div>
        <h1>{p.name} {p.is_vip && <span className="vip">VIP</span>}</h1>
        <div className="head-actions">
          {!p.erased_at && canEdit(user) && <button className="btn" onClick={() => setEditing(true)}>Edit</button>}
          {!p.erased_at && user.role === 'admin' && <button className="btn danger" onClick={erase}>Erase (GDPR)</button>}
        </div>
      </header>
      {actionError && <div className="error">{actionError}</div>}
      {p.erased_at && <p className="hint-box">Erased {formatDate(p.erased_at)}. Only the reference remains.</p>}
      <div className="problem-grid">
        <div className="problem-main">
          <section className="card">
            <h2>Incidents</h2>
            {p.incidents.length === 0 ? <p className="placeholder">No incidents as caller or affected person.</p> : (
              <ul className="plain-list">
                {p.incidents.map((i) => (
                  <li key={i.ref}><Link to={`/incidents/${i.ref}`} className="mono small">{i.ref}</Link> {i.title} <span className="muted small">{i.status.replace('_', ' ')} · P{i.priority} · {i.role}</span></li>
                ))}
              </ul>
            )}
          </section>
          {(p.services.length > 0 || p.owns.length > 0) && (
            <section className="card">
              <h2>Services</h2>
              {p.services.length > 0 && <><div className="muted small">Consumed by {p.organisation}</div><ul className="plain-list">{p.services.map((s) => <li key={s.ref}><Link to={`/cis/${s.ref}`}>{s.name}</Link></li>)}</ul></>}
              {p.owns.length > 0 && <><div className="muted small">Owns or supports</div><ul className="plain-list">{p.owns.map((s) => <li key={s.ref}><Link to={`/cis/${s.ref}`}>{s.name}</Link> <span className="muted small">{s.role}</span></li>)}</ul></>}
            </section>
          )}
        </div>
        <aside className="problem-side">
          <section className="card">
            <h2>Contact</h2>
            <dl className="kv details">
              <dt>Email</dt><dd>{p.email ? <a href={`mailto:${p.email}`}>{p.email}</a> : '–'}</dd>
              <dt>Phone</dt><dd>{p.phone || '–'}</dd>
              <dt>Title</dt><dd>{p.title || '–'}</dd>
              <dt>Department</dt><dd>{p.department || '–'}</dd>
              <dt>Location</dt><dd>{p.location || '–'}</dd>
              <dt>Organisation</dt><dd>{p.organisation ?? '–'}</dd>
              <dt>Manager</dt><dd>{p.manager_id ? <Link to={`/people/${p.manager_id}`}>{p.manager}</Link> : '–'}</dd>
              <dt>Source</dt><dd>{p.source}{p.external_id ? <span className="muted small"> · {p.external_id}</span> : ''}</dd>
              {!p.active && <><dt>Status</dt><dd>Inactive</dd></>}
            </dl>
          </section>
        </aside>
      </div>
      {editing && <PersonModal person={p} orgs={orgs ?? []} onClose={() => setEditing(false)} onDone={() => { setEditing(false); reload(); }} />}
    </>
  );
}

function PersonModal({ person, orgs, onClose, onDone }: { person?: Person; orgs: Organisation[]; onClose: () => void; onDone: (p: Person) => void }) {
  const { user } = useSession();
  const [form, setForm] = useState({
    name: person?.name ?? '', email: person?.email ?? '', phone: person?.phone ?? '', title: person?.title ?? '', department: person?.department ?? '',
    location: person?.location ?? '', organisation_id: person?.organisation_id ? String(person.organisation_id) : '', is_vip: person?.is_vip ?? false, active: person?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {
      name: form.name, email: form.email.trim() || null, phone: form.phone, title: form.title, department: form.department, location: form.location,
      organisation_id: form.organisation_id ? Number(form.organisation_id) : null, active: form.active,
    };
    if (isManager(user)) body.is_vip = form.is_vip;
    try {
      onDone(person ? await api.patch<Person>(`/api/people/${person.id}`, body) : await api.post<Person>('/api/people', body));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const field = (k: 'name' | 'email' | 'phone' | 'title' | 'department' | 'location', label: string, type = 'text') => (
    <label>{label}<input type={type} required={k === 'name'} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>
  );
  return (
    <Modal title={person ? `Edit ${person.name}` : 'Add a contact'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {field('name', 'Name')}{field('email', 'Email', 'email')}{field('phone', 'Phone', 'tel')}{field('title', 'Title')}{field('department', 'Department')}{field('location', 'Location')}
        <label>Organisation<select value={form.organisation_id} onChange={(e) => setForm({ ...form, organisation_id: e.target.value })}><option value="">–</option>{orgs.filter((o) => o.active).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        {isManager(user) && <label className="check"><input type="checkbox" checked={form.is_vip} onChange={(e) => setForm({ ...form, is_vip: e.target.checked })} /> VIP <span className="muted small">(raises the suggested impact of their incidents)</span></label>}
        {person && <label className="check"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>}
        <p className="muted small full">Record only what is needed to handle incidents. Contact details are personal data.</p>
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

function OrganisationModal({ org, onClose, onDone }: { org?: Organisation; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: org?.name ?? '', kind: org?.kind ?? 'internal', description: org?.description ?? '', active: org?.active ?? true, services: (org?.services ?? []).map((s) => s.ref) });
  const { data: services } = useApi<{ ref: string; name: string }[]>('/api/cis?class=service&limit=200');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (org) await api.put(`/api/organisations/${org.id}`, form);
      else await api.post('/api/organisations', form);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title={org ? `Edit ${org.name}` : 'Add an organisation'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Kind<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'internal' | 'customer' })}><option value="internal">Internal department</option><option value="customer">Customer</option></select></label>
        <label className="full">Description<textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <fieldset className="full source-fields">
          <legend>Services consumed</legend>
          <div className="check-grid">
            {services?.map((s) => (
              <label key={s.ref} className="check"><input type="checkbox" checked={form.services.includes(s.ref)} onChange={(e) => setForm({ ...form, services: e.target.checked ? [...form.services, s.ref] : form.services.filter((r) => r !== s.ref) })} /> {s.name}</label>
            ))}
            {services?.length === 0 && <span className="muted small">No services in the CMDB yet.</span>}
          </div>
        </fieldset>
        {org && <label className="check"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>}
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}
