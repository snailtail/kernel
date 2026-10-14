import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { Problem } from '../api';
import { ProblemTable } from '../components/ProblemTable';
import { PRIORITY_LABEL, STATUS_LABEL } from '../format';
import { useLive } from '../live';
import { useApi } from '../hooks';
import { canEdit, useSession } from '../session';
import { SavedViews } from '../components/SavedViews';

export function ProblemsPage() {
  const { user, meta } = useSession();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');

  // Debounce free text into the URL so filters are shareable.
  useEffect(() => {
    const t = setTimeout(() => setParam('q', q), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const setParam = (key: string, value: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };

  const query = new URLSearchParams(params);
  if (!query.get('status')) query.set('status', 'open');
  const { data, error, loading, refresh } = useApi<Problem[]>(`/api/problems?${query}`);
  useLive(['problem:*'], refresh);

  return (
    <>
      <header className="page-head">
        <h1>Problems</h1>
        <SavedViews page="problems" />
        {canEdit(user) && <Link className="btn primary page-new" to="/problems/new">New problem</Link>}
      </header>
      <div className="filters">
        <input className="search" placeholder="Search ref, title, root cause, workaround…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={params.get('status') ?? 'open'} onChange={(e) => setParam('status', e.target.value === 'open' ? '' : e.target.value)}>
          <option value="open">All open</option>
          {meta.statuses.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          <option value="all">All</option>
        </select>
        <select value={params.get('priority') ?? ''} onChange={(e) => setParam('priority', e.target.value)}>
          <option value="">Any priority</option>
          {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>P{p} {PRIORITY_LABEL[p]}</option>)}
        </select>
        <select value={params.get('assignee_id') ?? ''} onChange={(e) => setParam('assignee_id', e.target.value)}>
          <option value="">Any assignee</option>
          <option value={String(user.id)}>Me</option>
          {meta.assignees.filter((a) => a.id !== user.id).map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
        </select>
        <select value={params.get('category_id') ?? ''} onChange={(e) => setParam('category_id', e.target.value)}>
          <option value="">Any category</option>
          {meta.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          value={params.get('needs_decision') ? 'needs_decision' : params.get('review_due') ? 'review_due' : ''}
          onChange={(e) => setParams((prev) => {
            const next = new URLSearchParams(prev);
            next.delete('needs_decision');
            next.delete('review_due');
            if (e.target.value) next.set(e.target.value, 'true');
            return next;
          }, { replace: true })}
        >
          <option value="">Any decision state</option>
          <option value="needs_decision">Awaiting decision</option>
          <option value="review_due">Decision review due</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={params.get('is_major') === 'true'} onChange={(e) => setParam('is_major', e.target.checked ? 'true' : '')} />
          Major only
        </label>
        <select value={params.get('sort') ?? 'priority'} onChange={(e) => setParam('sort', e.target.value === 'priority' ? '' : e.target.value)}>
          <option value="priority">Sort: priority</option>
          <option value="updated">Sort: last updated</option>
          <option value="created">Sort: newest</option>
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      <section className={`card flush ${loading ? 'is-loading' : ''}`}>
        {data && <ProblemTable problems={data} />}
      </section>
    </>
  );
}
