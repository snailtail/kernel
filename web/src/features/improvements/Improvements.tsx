// The continual improvement register (#52): a list, a Kanban board by status and a value/effort matrix, and the page
// of one improvement. Lightweight on purpose: the work itself happens in the changes, problems and actions it links.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { SavedViews } from '../../components/SavedViews';
import { useApi, useListParams, useSearchText } from '../../hooks';
import { useLive } from '../../hooks/useLive';
import { canEdit, useSession } from '../../session';
import { IMPROVEMENT_STATUS } from '../../statuses';
import type { ImprovementRow } from '../../api/types/improvements';
import { STATUSES, ModelHint } from './common';
import { ImprovementList } from './components/ImprovementList';
import { Board } from './components/Board';
import { Matrix } from './components/Matrix';
import { NewImprovement } from './components/ImprovementForms';
import './styles.css';

/** Keys a link to the create form carries (a service report, a KPI tile); they are not list filters. */
const PREFILL = ['source', 'service', 'from', 'to', 'kpi', 'source_ref'];

export function ImprovementsPage() {
  const { user } = useSession();
  const navigate = useNavigate();
  const { params, setParams, set } = useListParams();
  const [q, setQ] = useSearchText();
  const tab = params.get('tab') ?? 'list';
  // A link from a service report or a KPI tile opens the form with what it knows (#54); those keys are not filters.
    const [creating, setCreating] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setCreating(Object.fromEntries(PREFILL.filter((k) => params.has(k)).map((k) => [k, params.get(k)!])));
    const next = new URLSearchParams(params);
    for (const k of ['new', ...PREFILL]) next.delete(k);
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  const query = new URLSearchParams([...params].filter(([k]) => k !== 'tab' && !PREFILL.includes(k)));
  // The board shows every status in its own column.
  if (tab === 'board' && !query.has('status')) query.set('status', 'all');
  const { data, loading, refresh, reload } = useApi<ImprovementRow[]>(params.get('new') === '1' ? null : `/api/improvements?${query}`);
  useLive(['improvement:*'], refresh);
  const empty = data?.length === 0 && ![...query.keys()].some((k) => k !== 'status' || query.get('status') !== 'all');

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Improvements</h1>
          <p className="muted">The continual improvement register: ideas from reviews, problems and service reviews, rated by value and effort, and the benefit they brought.</p>
        </div>
        {tab === 'list' && <SavedViews list="improvements" />}
        {canEdit(user) && <button className="btn primary page-new" onClick={() => setCreating({})}>Suggest an improvement</button>}
      </header>
      <div className="seg-toggle tabs" role="tablist">
        {[['list', 'List'], ['board', 'Board'], ['matrix', 'Value / effort']].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => set('tab', id === 'list' ? '' : id)}>{label}</button>
        ))}
      </div>
      <div className="filters">
        <input className="search" placeholder="Search improvements…" value={q} onChange={(e) => setQ(e.target.value)} />
        {tab !== 'board' && (
          <select value={params.get('status') ?? 'open'} onChange={(e) => set('status', e.target.value === 'open' ? '' : e.target.value)} aria-label="Status">
            <option value="open">Open</option>{STATUSES.map((s) => <option key={s} value={s}>{IMPROVEMENT_STATUS[s]}</option>)}<option value="all">All</option>
          </select>
        )}
        <select value={params.get('owner') ?? ''} onChange={(e) => set('owner', e.target.value)} aria-label="Owner">
          <option value="">Anyone</option><option value="me">Mine</option><option value="none">No owner</option>
        </select>
        <label className="check"><input type="checkbox" checked={params.get('quick_wins') === 'true'} onChange={(e) => set('quick_wins', e.target.checked ? 'true' : '')} /> Quick wins</label>
      </div>
      {empty && <ModelHint />}
      {tab === 'list' && <ImprovementList rows={data} loading={loading} filter={query.toString()} onChanged={refresh} />}
      {tab === 'board' && data && <Board rows={data} editable={canEdit(user)} onChanged={reload} />}
      {tab === 'matrix' && data && <Matrix rows={data} />}
      {creating && <NewImprovement prefill={creating} onClose={() => setCreating(null)} onDone={(ref) => navigate(`/improvements/${ref}`)} />}
    </>
  );
}
