import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../../../api/client';
import type { CiDetail } from '../../../api/types/cmdb';

export function CiLinks({ ci, editable, onChange }: { ci: CiDetail; editable: boolean; onChange: (c: CiDetail) => void }) {
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
