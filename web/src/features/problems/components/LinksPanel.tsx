import { useState, type FormEvent } from 'react';
import { api, type LinkKind, type ProblemDetail } from '../../../api/client';
import { LINK_LABEL } from '../../../format';
import { useApi } from '../../../hooks';
import { useSession } from '../../../session';

export function LinksPanel({ problem: p, editable, onChange }: { problem: ProblemDetail; editable: boolean; onChange: (p: ProblemDetail) => void }) {
  const { meta } = useSession();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ kind: (p.detection === 'proactive' ? 'event' : 'incident') as LinkKind, reference: '', system: '', url: '', note: '' });
  const [error, setError] = useState<string | null>(null);
  const { data: systems } = useApi<{ id: number; name: string; url_templates: Record<string, string>; active: boolean }[]>(adding ? '/api/systems' : null);
  const templated = !!systems?.find((s) => s.name.toLowerCase() === form.system.toLowerCase())?.url_templates[form.kind];

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      onChange(await api.post<ProblemDetail>(`/api/problems/${p.ref}/links`, form));
      setForm((f) => ({ ...f, reference: '', url: '', note: '' }));
      setAdding(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (id: number) => {
    if (!confirm('Remove this link?')) return;
    try {
      onChange(await api.del<ProblemDetail>(`/api/problems/${p.ref}/links/${id}`));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="card links">
      <div className="section-head">
        <h2>Linked records</h2>
        {editable && !adding && <button className="btn-link" onClick={() => setAdding(true)}>+ Link</button>}
      </div>
      {adding && (
        <form className="link-form" onSubmit={add}>
          <div className="row">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as LinkKind })}>
              {meta.link_kinds.map((k) => <option key={k} value={k}>{LINK_LABEL[k]}</option>)}
            </select>
            <input required autoFocus placeholder="Reference, e.g. INC0012345" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </div>
          <input placeholder="System (ServiceNow, Jira, Zabbix…)" list="link-systems" value={form.system} onChange={(e) => setForm({ ...form, system: e.target.value })} />
          <datalist id="link-systems">{systems?.filter((s) => s.active).map((s) => <option key={s.id} value={s.name} />)}</datalist>
          <input type="url" placeholder={templated ? 'Link generated from the system template' : 'https://… (link to the record)'} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <input placeholder="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <div className="actions">
            <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn primary">Add link</button>
          </div>
        </form>
      )}
      {error && <div className="error">{error}</div>}
      {p.links.length === 0 && !adding && <p className="placeholder">No incidents, events or changes linked.</p>}
      {meta.link_kinds.map((kind) => {
        const items = p.links.filter((l) => l.kind === kind);
        if (!items.length) return null;
        return (
          <div key={kind} className="link-group">
            <h3>{LINK_LABEL[kind]}s <span className="count">{items.length}</span></h3>
            <ul>
              {items.map((l) => (
                <li key={l.id}>
                  <div className="link-main">
                    {l.url ? <a href={l.url} target="_blank" rel="noreferrer noopener" className="mono">{l.reference} ↗</a> : <span className="mono">{l.reference}</span>}
                    {l.system && <span className="tag">{l.system}</span>}
                    {editable && <button className="btn-icon small" onClick={() => remove(l.id)} aria-label="Remove link">×</button>}
                  </div>
                  {l.note && <div className="muted small">{l.note}</div>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
