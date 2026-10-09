import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';

export interface AffectedCi { ref: string; name: string; type: 'ci' | 'service'; type_label: string; status: string; criticality: number }
export interface AffectedService { ref: string; name: string; criticality: number; via: string[] }
export interface ImpactHint { suggested_impact: number; reason: string; incomplete: boolean }

const CRIT = ['', 'Business critical', 'High', 'Medium', 'Low'];

interface WithAffected { ref: string; affected_cis: AffectedCi[]; affected_services: AffectedService[]; impact_hint: ImpactHint | null; impact_incomplete: boolean }

/** The CIs and services a problem or incident affects, the services reached through the CMDB, and an impact hint. */
export function AffectedCisPanel<T extends WithAffected>({ record: p, basePath, editable, onChange }: { record: T; basePath: string; editable: boolean; onChange: (p: T) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ ref: string; name: string; type_label: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    const t = setTimeout(() => api.get<any[]>(`/api/cis?${new URLSearchParams({ q, limit: '6' })}`).then(setHits, () => setHits([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  const run = async (fn: () => Promise<T>) => {
    setError(null);
    try {
      onChange(await fn());
      setQ('');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const linked = new Set(p.affected_cis.map((c) => c.ref));
  const derived = p.affected_services.filter((s) => !linked.has(s.ref));
  return (
    <section className="card">
      <h2>Affected CIs &amp; services</h2>
      {p.affected_cis.length === 0 && <p className="placeholder">None linked. Link the CIs or services from the CMDB to see what is affected.</p>}
      <ul className="plain-list">
        {p.affected_cis.map((c) => (
          <li key={c.ref} className="affected">
            <Link to={`/cis/${c.ref}`}><span className="mono small">{c.ref}</span> {c.name}</Link>
            <span className="muted small">{c.type_label}{c.status !== 'active' ? ` · ${c.status}` : ''}</span>
            {editable && <button className="btn-icon small" aria-label={`Unlink ${c.ref}`} onClick={() => run(() => api.del<T>(`${basePath}/cis/${c.ref}`))}>×</button>}
          </li>
        ))}
      </ul>
      {derived.length > 0 && (
        <div className="derived">
          <div className="muted small">Services affected through the CMDB</div>
          {derived.map((s) => (
            <div key={s.ref}>
              <Link to={`/cis/${s.ref}`}>{s.name}</Link> <span className={`crit crit-${s.criticality}`}>{CRIT[s.criticality]}</span>
              {s.via?.length > 0 && <span className="muted small"> via {s.via.join(', ')}</span>}
            </div>
          ))}
        </div>
      )}
      {p.impact_incomplete && <p className="muted small">The CMDB picture may be incomplete (large or deep graph).</p>}
      {p.impact_hint && (
        <div className="hint-box hint-row">
          {p.impact_hint.reason}
          {editable && (
            <button className="btn small" onClick={() => run(() => api.patch<T>(basePath, { impact: p.impact_hint!.suggested_impact }))}>Update impact</button>
          )}
        </div>
      )}
      {editable && (
        <div className="ci-picker">
          <input placeholder="Link a CI or service…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a CI or service" />
          {hits.length > 0 && (
            <ul className="ci-hits">
              {hits.filter((h) => !linked.has(h.ref)).map((h) => (
                <li key={h.ref}><button onClick={() => run(() => api.post<T>(`${basePath}/cis`, { ci: h.ref }))}><span className="mono small">{h.ref}</span> {h.name} <span className="muted small">{h.type_label}</span></button></li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}
