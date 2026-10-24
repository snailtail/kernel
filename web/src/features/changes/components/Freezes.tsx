import { useState } from 'react';
import { api } from '../../../api/client';
import { formatDate } from '../../../format';
import { useApi } from '../../../hooks';

export function Freezes({ manager }: { manager: boolean }) {
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
