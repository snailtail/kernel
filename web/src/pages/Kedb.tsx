import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Problem } from '../api';
import { PriorityBadge, StatusBadge } from '../components/Badges';
import { formatDate } from '../format';
import { useApi } from '../hooks';

export function KedbPage() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [includeResolved, setIncludeResolved] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error } = useApi<Problem[]>(
    `/api/kedb?${new URLSearchParams({ q: debounced, include_resolved: String(includeResolved) })}`,
  );

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Known Error Database</h1>
          <p className="muted">Problems that have been analysed but not yet resolved, with their root cause and workaround.</p>
        </div>
      </header>
      <div className="filters">
        <input className="search" placeholder="Search symptoms, services, workarounds…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={includeResolved} onChange={(e) => setIncludeResolved(e.target.checked)} />
          Include resolved
        </label>
      </div>
      {error && <div className="error">{error}</div>}
      {data?.length === 0 && <p className="empty">No known errors match.</p>}
      <div className="kedb">
        {data?.map((p) => (
          <article key={p.id} className="card kedb-item">
            <header>
              <Link to={`/problems/${p.ref}`} className="mono">{p.ref}</Link>
              <h3><Link to={`/problems/${p.ref}`}>{p.title}</Link></h3>
              <span className="spacer" />
              <PriorityBadge priority={p.priority} />
              <StatusBadge status={p.status} />
            </header>
            <div className="kedb-meta muted">
              {p.affected_service && <span>Service: {p.affected_service}</span>}
              {p.category && <span>Category: {p.category}</span>}
              <span>Known error since {formatDate(p.known_error_at)}</span>
            </div>
            <div className="kedb-cols">
              <div>
                <h4>Root cause</h4>
                <p className="prose">{p.root_cause || <span className="muted">Not documented</span>}</p>
              </div>
              <div>
                <h4>Workaround</h4>
                <p className="prose">{p.workaround || <span className="muted">No workaround available</span>}</p>
              </div>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
