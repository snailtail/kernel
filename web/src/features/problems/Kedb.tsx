import { Link, useSearchParams } from 'react-router';
import type { Problem } from '../../api/client';
import { PriorityBadge, StatusBadge } from '../../components/Badges';
import { Markdown } from '../../components/Markdown';
import { DECISION_LABEL, EFFECTIVENESS_LABEL, formatDate } from '../../format';
import { useApi, useSearchText } from '../../hooks';
import { useListToolkit } from '../../components/list/ListToolkit';
import { SavedViews } from '../../components/SavedViews';

export function KedbPage() {
  // Search and "include resolved" live in the address, so they can be shared and saved as views (#110).
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useSearchText();
  const includeResolved = params.get('include_resolved') === 'true';
  const { data, error, refresh } = useApi<Problem[]>(
    `/api/kedb?${new URLSearchParams({ q: params.get('q') ?? '', include_resolved: String(includeResolved) })}`,
  );
  // The known error database shows everything that matches, so "select all" is all; bulk acts on the problems.
  const tk = useListToolkit({ list: 'known_errors', rows: data, idOf: (p) => p.ref, hrefOf: (p) => `/problems/${p.ref}`, filter: params.toString(), pageSize: Infinity, onChanged: refresh });

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Known Error Database</h1>
          <p className="muted">Problems that have been analysed but not yet resolved, with their root cause and workaround.</p>
        </div>
        <SavedViews list="known_errors" />
      </header>
      <div className="filters">
        <input className="search" placeholder="Search symptoms, services, workarounds…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check">
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(e) => setParams((prev) => { const n = new URLSearchParams(prev); if (e.target.checked) n.set('include_resolved', 'true'); else n.delete('include_resolved'); return n; }, { replace: true })}
          />
          Include resolved
        </label>
        {tk.selectAll && data && data.length > 0 && <label className="check">{tk.selectAll} Select all</label>}
      </div>
      {error && <div className="error">{error}</div>}
      {data?.length === 0 && <p className="empty">No known errors match.</p>}
      <div className="kedb">
        {data?.map((p, n) => (
          <article key={p.id} {...tk.rowProps(p, n)} className={['card kedb-item', tk.rowProps(p, n).className].filter(Boolean).join(' ')}>
            <header>
              {tk.select(p, n)}
              <Link to={`/problems/${p.ref}`} className="mono">{p.ref}</Link>
              <h3><Link to={`/problems/${p.ref}`}>{p.title}</Link></h3>
              <span className="spacer" />
              <PriorityBadge priority={p.priority} />
              <StatusBadge kind="problem" status={p.status} />
            </header>
            <div className="kedb-meta muted">
              {p.affected_service && <span>Service: {p.affected_service}</span>}
              {p.category && <span>Category: {p.category}</span>}
              <span>Known error since {formatDate(p.known_error_at)}</span>
            </div>
            <div className="ec-chips">
              <span className={`badge decision-${p.ec_decision ?? 'pending'}`}>{DECISION_LABEL[p.ec_decision ?? 'pending']}</span>
              {p.workaround_effectiveness && <span className={`badge eff-${p.workaround_effectiveness}`}>{EFFECTIVENESS_LABEL[p.workaround_effectiveness]}</span>}
            </div>
            <div className="kedb-cols">
              <div>
                <h4>Root cause</h4>
                {p.root_cause ? <Markdown text={p.root_cause} /> : <p className="muted">Not documented</p>}
              </div>
              <div>
                <h4>Workaround</h4>
                {p.workaround ? <Markdown text={p.workaround} /> : <p className="muted">No workaround available</p>}
              </div>
            </div>
          </article>
        ))}
      </div>
      {tk.bar}
    </>
  );
}
