import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type ProblemDetail } from '../../../api/client';

/** Native incidents linked to the problem; once it is resolved, their open incidents can be resolved in one go. */
export function ProblemIncidents({ problem: p, editable, onChange }: { problem: ProblemDetail; editable: boolean; onChange: (p: ProblemDetail) => void }) {
  const open = p.incidents.filter((i) => !['resolved', 'closed'].includes(i.status));
  const [error, setError] = useState<string | null>(null);
  if (!p.incidents.length) return null;
  const resolveAll = async () => {
    const resolution = window.prompt(`Resolve ${open.length} open incident(s) with this problem's resolution?`, p.resolution || `Resolved by problem ${p.ref}.`);
    if (!resolution?.trim()) return;
    try {
      const result = await api.post<ProblemDetail & { resolve_result: { resolved: string[]; failed: { ref: string; error: string }[] } }>(`/api/problems/${p.ref}/resolve-incidents`, { incidents: open.map((i) => i.ref), resolution });
      onChange(result);
      if (result.resolve_result.failed.length) setError(`Not resolved: ${result.resolve_result.failed.map((f) => `${f.ref} (${f.error})`).join('; ')}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Incidents <span className="count">{open.length ? `${open.length} open` : p.incidents.length}</span></h2>
      <ul className="plain-list">
        {p.incidents.map((i) => (
          <li key={i.ref}>
            <Link to={`/incidents/${i.ref}`} className="mono">{i.ref}</Link> {i.title} <span className="muted small">{i.status.replace('_', ' ')}</span>
          </li>
        ))}
      </ul>
      {editable && open.length > 0 && ['resolved', 'closed'].includes(p.status) && (
        <div className="hint-box hint-row">
          The problem is resolved: {open.length} linked incident{open.length > 1 ? 's are' : ' is'} still open.
          <button className="btn small" onClick={resolveAll}>Resolve them</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}

/** Changes raised for the problem's fix; "Raise change" prefills one from the known error. */
/** Lessons learned → improvement (#52): optional, once the problem is resolved or closed. */
export function ProblemImprovements({ problem: p, editable }: { problem: ProblemDetail; editable: boolean }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const done = ['resolved', 'closed'].includes(p.status);
  const list = p.improvements ?? [];
  if (!list.length && !(editable && done)) return null;
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const m = await api.post<{ ref: string }>(`/api/problems/${p.ref}/improvement`, { title });
      navigate(`/improvements/${m.ref}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Improvements</h2>
      <ul className="plain-list">
        {list.map((m) => <li key={m.ref}><Link to={`/improvements/${m.ref}`} className="mono">{m.ref}</Link> {m.title} <span className="muted small">{m.status.replace('_', ' ')}</span></li>)}
      </ul>
      {editable && done && (
        <form className="rel-form small" onSubmit={create}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Lessons learned: what should change?" aria-label="Improvement title" />
          <button className="btn small" disabled={!title.trim()}>Suggest an improvement</button>
        </form>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}

export function ProblemChanges({ problem: p, editable }: { problem: ProblemDetail; editable: boolean }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  if (!p.changes.length && !(editable && ['known_error', 'analysis'].includes(p.status))) return null;
  const raise = async () => {
    try {
      const c = await api.post<{ ref: string }>(`/api/problems/${p.ref}/change`, {});
      navigate(`/changes/${c.ref}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card">
      <div className="section-head"><h2>Changes</h2>{editable && <button className="btn-link" onClick={raise}>+ Raise change for fix</button>}</div>
      {p.changes.length === 0 && <p className="placeholder">The permanent fix is usually implemented through a change.</p>}
      <ul className="plain-list">
        {p.changes.map((c) => (
          <li key={c.ref}><Link to={`/changes/${c.ref}`} className="mono">{c.ref}</Link> {c.title} <span className="muted small">{c.status}{c.outcome ? `, ${c.outcome.replace('_', ' ')}` : ''}</span></li>
        ))}
      </ul>
      {error && <div className="error">{error}</div>}
    </section>
  );
}
