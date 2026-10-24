// Development work (#165): a team's backlog in rank order, with drag and drop and the keyboard to reorder it, filters
// on type, label and epic, and the team's Definition of Ready and Done.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api/client';
import { SavedViews } from '../../components/SavedViews';
import { useApi, useListParams, useSearchText } from '../../hooks';
import { useLive } from '../../hooks/useLive';
import { canEdit, useSession } from '../../session';
import { WORK_ITEM_STATUS, type WorkItemStatus } from '../../statuses';
import type { Team } from '../../api/types/teams';
import type { WorkItemRow } from '../../api/types/development';
import { TYPE_LABEL, TYPES } from './common';
import { BacklogList, type Place } from './components/BacklogList';
import { DefinitionsCard } from './components/DefinitionsCard';
import { NewWorkItem } from './components/WorkItemForms';

export function BacklogPage() {
  const { user } = useSession();
  const navigate = useNavigate();
  const { params, setParams, set } = useListParams();
  const [q, setQ] = useSearchText();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: teams } = useApi<Team[]>('/api/teams');
  const team = params.get('team');
  // Without a team in the URL, open the person's own team's backlog (or the first one).
  useEffect(() => {
    if (team || !teams) return;
    const first = teams.find((t) => t.mine && t.active) ?? teams.find((t) => t.active);
    const next = new URLSearchParams(params);
    next.set('team', first ? String(first.id) : 'none');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, teams]);
  const { data, loading, refresh, reload } = useApi<WorkItemRow[]>(team ? `/api/work-items?${params}` : null);
  const { data: epics } = useApi<WorkItemRow[]>(team ? `/api/work-items?type=epic&limit=200&team=${team}` : null);
  useLive(['work_item:*'], refresh);
  const status = params.get('status') ?? 'open';
  const editable = canEdit(user);
  const move = async (ref: string, place: Place) => {
    setError(null);
    try {
      await api.post(`/api/work-items/${ref}/move`, place);
    } catch (err) {
      setError((err as Error).message);
      reload();
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Backlog</h1>
          <p className="muted">Epics, stories, bugs and tasks in the order the team takes them: the top is what comes next.</p>
        </div>
        <SavedViews list="work_items" />
        {editable && <button className="btn primary page-new" onClick={() => setCreating(true)}>New item</button>}
      </header>
      <div className="filters">
        <select value={team ?? ''} onChange={(e) => set('team', e.target.value)} aria-label="Team">
          {(teams ?? []).filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          <option value="none">No team</option>
        </select>
        <input className="search" placeholder="Search the backlog…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => set('status', e.target.value === 'open' ? '' : e.target.value)} aria-label="Status">
          <option value="open">Backlog (open)</option>{(Object.keys(WORK_ITEM_STATUS) as WorkItemStatus[]).map((s) => <option key={s} value={s}>{WORK_ITEM_STATUS[s]}</option>)}<option value="all">All</option>
        </select>
        <select value={params.get('type') ?? ''} onChange={(e) => set('type', e.target.value)} aria-label="Type">
          <option value="">Every type</option>{TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <select value={params.get('epic') ?? ''} onChange={(e) => set('epic', e.target.value)} aria-label="Epic">
          <option value="">Any epic</option>{(epics ?? []).map((ep) => <option key={ep.ref} value={ep.ref}>{ep.title}</option>)}
        </select>
        <input className="label-filter" placeholder="Label" value={params.get('label') ?? ''} onChange={(e) => set('label', e.target.value.trim())} aria-label="Label" />
        <select value={params.get('assignee') ?? ''} onChange={(e) => set('assignee', e.target.value)} aria-label="Assignee">
          <option value="">Anyone</option><option value="me">Mine</option><option value="none">Unassigned</option>
        </select>
      </div>
      {editable && status === 'open' && <p className="muted small wi-hint">Drag a row, or focus it and press Alt+↑ / Alt+↓ (Alt+Home for the top).</p>}
      {error && <div className="error">{error}</div>}
      <div className="wi-layout">
        <div>{loading && !data ? <p className="muted">Loading…</p> : data && <BacklogList rows={data} movable={editable && status === 'open'} onMove={move} />}</div>
        {team && team !== 'none' && <aside><DefinitionsCard teamId={Number(team)} /></aside>}
      </div>
      {creating && <NewWorkItem team={team ?? undefined} onClose={() => setCreating(false)} onDone={(ref) => navigate(`/work/${ref}`)} />}
    </>
  );
}
