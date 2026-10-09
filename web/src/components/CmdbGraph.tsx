import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { useApi } from '../hooks';
import { Modal } from './Modal';

export interface Relationship { id: number; type: string; direction: 'outgoing' | 'incoming'; label: string; ref: string; name: string; other_type: string; status: string; discovered_by: string | null; last_seen_at: string }
interface RelType { name: string; label: string; inverse_label: string; propagation: string }
interface ImpactNode { ref: string; name: string; type: 'ci' | 'service'; type_label: string; status: string; criticality: number; depth: number; via: string | null; relationship: { from: string; label: string; to: string } }
interface Impact { meaning: string; truncated: boolean; depth_limit_reached: boolean; max_depth: number; max_nodes: number; count: number; nodes: ImpactNode[]; services: { ref: string; name: string; criticality: number }[] }

const CRIT = ['', 'Business critical', 'High', 'Medium', 'Low'];

/** Relationships of a CI, grouped by how they read from this CI ("runs on", "hosts"…). */
export function RelationshipsSection({ ciRef, relationships, editable, onChange }: { ciRef: string; relationships: Relationship[]; editable: boolean; onChange: (ci: any) => void }) {
  const { data: types } = useApi<RelType[]>('/api/ci-relationship-types');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ choice: 'depends_on:outgoing', target: '' });
  const [error, setError] = useState<string | null>(null);
  const groups = new Map<string, Relationship[]>();
  for (const r of relationships) groups.set(r.label, [...(groups.get(r.label) ?? []), r]);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const [type, direction] = form.choice.split(':');
    try {
      onChange(await api.post(`/api/cis/${ciRef}/relationships`, { type, direction, target: form.target.trim() }));
      setAdding(false);
      setForm({ ...form, target: '' });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card">
      <div className="section-head"><h2>Relationships</h2>{editable && !adding && <button className="btn-link" onClick={() => setAdding(true)}>+ Add</button>}</div>
      {adding && types && (
        <form className="rel-form" onSubmit={add}>
          <span className="mono muted">{ciRef}</span>
          <select value={form.choice} onChange={(e) => setForm({ ...form, choice: e.target.value })} aria-label="Relationship">
            {types.flatMap((t) => [
              <option key={`${t.name}:outgoing`} value={`${t.name}:outgoing`}>{t.label}</option>,
              <option key={`${t.name}:incoming`} value={`${t.name}:incoming`}>{t.inverse_label}</option>,
            ])}
          </select>
          <input required placeholder="CI or service ref, e.g. CI000012" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} />
          <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
          <button className="btn primary">Add</button>
        </form>
      )}
      {error && <div className="error">{error}</div>}
      {relationships.length === 0 && !adding && <p className="placeholder">No relationships yet. Relationships make impact analysis possible: what runs on what, and which services it is part of.</p>}
      <dl className="rels">
        {[...groups.entries()].map(([label, rels]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {rels.map((r) => (
                <span key={r.id} className={`rel-chip ${r.other_type === 'service' ? 'svc' : ''}`}>
                  <Link to={`/cis/${r.ref}`}><span className="mono">{r.ref}</span> {r.name}</Link>
                  {r.discovered_by ? <span className="muted small" title={`Discovered by ${r.discovered_by}`}>· {r.discovered_by}</span>
                    : editable && <button className="remove" aria-label={`Remove ${label} ${r.ref}`} onClick={async () => onChange(await api.del(`/api/cis/${ciRef}/relationships/${r.id}`))}>×</button>}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Impact (what breaks if this is down) or dependencies, laid out by distance. */
export function ImpactSection({ ciRef, isService }: { ciRef: string; isService: boolean }) {
  const [direction, setDirection] = useState<'up' | 'down'>(isService ? 'down' : 'up');
  const { data } = useApi<Impact>(`/api/cis/${ciRef}/impact?direction=${direction}`);
  const levels = new Map<number, ImpactNode[]>();
  for (const n of data?.nodes ?? []) levels.set(n.depth, [...(levels.get(n.depth) ?? []), n]);
  return (
    <section className="card">
      <div className="section-head">
        <h2>{direction === 'up' ? 'If this is down' : 'Depends on'}</h2>
        <div className="seg-toggle">
          <button className={direction === 'up' ? 'on' : ''} onClick={() => setDirection('up')}>Impact</button>
          <button className={direction === 'down' ? 'on' : ''} onClick={() => setDirection('down')}>Dependencies</button>
        </div>
      </div>
      {data && data.count === 0 && <p className="placeholder">{direction === 'up' ? 'Nothing is recorded as depending on this.' : 'No recorded dependencies.'}</p>}
      {data && direction === 'up' && data.services.length > 0 && (
        <p className="impact-summary">
          Affects {data.services.length} service{data.services.length > 1 ? 's' : ''}:{' '}
          {data.services.map((s, i) => <span key={s.ref}>{i > 0 && ', '}<Link to={`/cis/${s.ref}`}>{s.name}</Link> <span className={`crit crit-${s.criticality}`}>{CRIT[s.criticality]}</span></span>)}
        </p>
      )}
      {data && (data.truncated || data.depth_limit_reached) && (
        <p className="warn-box">
          {data.truncated ? `Showing the first ${data.max_nodes} items. ` : ''}
          {data.depth_limit_reached ? `The graph continues beyond ${data.max_depth} levels. ` : ''}
          The picture is incomplete.
        </p>
      )}
      {data && data.count > 0 && (
        <div className="impact-levels">
          {[...levels.entries()].map(([depth, nodes]) => (
            <div key={depth} className="impact-level">
              <div className="muted small">{depth === 1 ? 'Directly' : `${depth} steps away`}</div>
              {nodes.map((n) => (
                <Link key={n.ref} to={`/cis/${n.ref}`} className={`impact-node ${n.type === 'service' ? 'svc' : ''} crit-border-${n.criticality}`} title={`${n.relationship.from} ${n.relationship.label} ${n.relationship.to}`}>
                  <span className="mono small">{n.ref}</span>
                  <strong>{n.name}</strong>
                  <span className="muted small">{n.type_label}{n.status !== 'active' ? ` · ${n.status}` : ''}</span>
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface Group { id: number; name: string; purpose: string; description: string; rules: { match: 'all' | 'any'; conditions: Condition[] }; manual_members?: number }
interface Condition { field: string; key?: string; op: string; value: string }
interface GroupDetail extends Group { truncated: boolean; members: { ref: string; name: string; type: string; ci_type: string; status: string; criticality: number; team: string; manual: boolean; by_rule: boolean }[] }

const FIELDS = ['tag', 'ci_type', 'environment', 'status', 'team', 'name', 'criticality', 'attribute', 'source_system'];
const OPS: Record<string, string> = { eq: 'is', neq: 'is not', contains: 'contains', starts_with: 'starts with', lte: '≤', gte: '≥' };
const PURPOSES = ['service', 'flow', 'billing', 'monitoring', 'maintenance', 'other'];

export function GroupsPage({ canManage }: { canManage: boolean }) {
  const { data, reload } = useApi<Group[]>('/api/ci-groups');
  const [params] = useSearchParams();
  const [open, setOpen] = useState<number | 'new' | null>(params.get('open') ? Number(params.get('open')) : null);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>CI groups</h1>
          <p className="muted">Named sets of CIs: flows, billing, monitoring or maintenance groups. Members are added by hand or matched by rules.</p>
        </div>
        <div className="head-actions">
          <Link className="btn" to="/cis">Configuration items</Link>
          {canManage && <button className="btn primary" onClick={() => setOpen('new')}>New group</button>}
        </div>
      </header>
      {data?.length === 0 && <p className="empty">No groups yet.</p>}
      <div className="group-grid">
        {data?.map((g) => (
          <button key={g.id} className="card group-card" onClick={() => setOpen(g.id)}>
            <strong>{g.name}</strong> <span className="tag">{g.purpose}</span>
            <p className="muted small">{g.description || describeRules(g.rules)}</p>
          </button>
        ))}
      </div>
      {open !== null && <GroupEditor id={open === 'new' ? null : open} canManage={canManage} onClose={() => { setOpen(null); reload(); }} />}
    </>
  );
}

const describeRules = (r: Group['rules']) =>
  r.conditions.length ? r.conditions.map((c) => `${c.field === 'attribute' ? c.key : c.field} ${OPS[c.op]} ${c.value}`).join(r.match === 'all' ? ' and ' : ' or ') : 'Manual members only';

function GroupEditor({ id, canManage, onClose }: { id: number | null; canManage: boolean; onClose: () => void }) {
  const { data, setData } = useApi<GroupDetail>(id ? `/api/ci-groups/${id}` : null);
  const [draft, setDraft] = useState<Group | null>(id ? null : { id: 0, name: '', purpose: 'flow', description: '', rules: { match: 'all', conditions: [] } });
  const [addRef, setAddRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const g = draft ?? data;
  if (!g) return null;
  const edit = (patch: Partial<Group>) => setDraft({ ...g, ...patch });
  const setCond = (i: number, patch: Partial<Condition>) => edit({ rules: { ...g.rules, conditions: g.rules.conditions.map((c, n) => (n === i ? { ...c, ...patch } : c)) } });
  const run = async (fn: () => Promise<GroupDetail>) => {
    setError(null);
    try {
      const saved = await fn();
      setData(saved);
      setDraft(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const body = { name: g.name, purpose: g.purpose, description: g.description, rules: g.rules };
  return (
    <Modal title={id ? data?.name ?? g.name : 'New group'} onClose={onClose}>
      <div className="group-editor">
        <div className="form">
          <label>Name<input disabled={!canManage} value={g.name} onChange={(e) => edit({ name: e.target.value })} /></label>
          <label>Purpose<select disabled={!canManage} value={g.purpose} onChange={(e) => edit({ purpose: e.target.value })}>{PURPOSES.map((p) => <option key={p}>{p}</option>)}</select></label>
          <label className="full">Description<input disabled={!canManage} value={g.description} onChange={(e) => edit({ description: e.target.value })} /></label>
          <fieldset className="full rules">
            <legend>
              Rules: members match{' '}
              <select disabled={!canManage} value={g.rules.match} onChange={(e) => edit({ rules: { ...g.rules, match: e.target.value as 'all' | 'any' } })}><option value="all">all</option><option value="any">any</option></select>{' '}
              of
            </legend>
            {g.rules.conditions.map((c, i) => (
              <div key={i} className="rule-row">
                <select disabled={!canManage} value={c.field} onChange={(e) => setCond(i, { field: e.target.value })} aria-label="Field">{FIELDS.map((f) => <option key={f}>{f}</option>)}</select>
                {c.field === 'attribute' && <input disabled={!canManage} placeholder="key, e.g. os" value={c.key ?? ''} onChange={(e) => setCond(i, { key: e.target.value })} />}
                <select disabled={!canManage} value={c.op} onChange={(e) => setCond(i, { op: e.target.value })} aria-label="Operator">{Object.entries(OPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <input disabled={!canManage} value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} aria-label="Value" />
                {canManage && <button className="btn-icon" aria-label="Remove rule" onClick={() => edit({ rules: { ...g.rules, conditions: g.rules.conditions.filter((_, n) => n !== i) } })}>×</button>}
              </div>
            ))}
            {canManage && <button className="btn-link" onClick={() => edit({ rules: { ...g.rules, conditions: [...g.rules.conditions, { field: 'tag', op: 'eq', value: '' }] } })}>+ Rule</button>}
          </fieldset>
          {error && <div className="error full">{error}</div>}
          {canManage && (
            <div className="actions full">
              {id && <button className="btn danger" onClick={async () => { await api.del(`/api/ci-groups/${id}`); onClose(); }}>Delete</button>}
              <button className="btn primary" disabled={!draft} onClick={() => run(() => (id ? api.put<GroupDetail>(`/api/ci-groups/${id}`, body) : api.post<GroupDetail>('/api/ci-groups', body)))}>{draft ? 'Save' : 'Saved'}</button>
            </div>
          )}
        </div>
        {data && (
          <>
            <h3>Members <span className="count">{data.members.length}{data.truncated ? '+' : ''}</span></h3>
            {canManage && (
              <form className="rel-form" onSubmit={(e) => { e.preventDefault(); run(() => api.put<GroupDetail>(`/api/ci-groups/${data.id}/members/${addRef.trim()}`, {})).then(() => setAddRef('')); }}>
                <input placeholder="Add by ref, e.g. CI000012" value={addRef} onChange={(e) => setAddRef(e.target.value)} />
                <button className="btn" disabled={!addRef.trim()}>Add</button>
              </form>
            )}
            <ul className="work-list">
              {data.members.map((m) => (
                <li key={m.ref}>
                  <div><Link to={`/cis/${m.ref}`} className="mono">{m.ref}</Link> {m.name} <span className="muted small">{m.ci_type} · {m.status}</span></div>
                  <span className="work-meta">
                    {m.by_rule && <span className="tag">rule</span>}
                    {m.manual && <span className="tag">manual</span>}
                    {m.manual && canManage && <button className="btn-icon small" aria-label={`Remove ${m.ref}`} onClick={() => run(() => api.del<GroupDetail>(`/api/ci-groups/${data.id}/members/${m.ref}`))}>×</button>}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
