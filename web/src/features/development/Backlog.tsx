// Development work (#165): a team's backlog in rank order, with drag and drop and the keyboard to reorder it, filters
// on type, label and epic, the team's Definition of Ready and Done, and where a mirrored backlog comes from (#168).
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api/client';
import { SavedViews } from '../../components/SavedViews';
import { useApi, useSearchText } from '../../hooks';
import { useLive } from '../../hooks/useLive';
import { canEdit, useSession } from '../../session';
import { WORK_ITEM_STATUS, type WorkItemStatus } from '../../statuses';
import type { WorkItemRow } from '../../api/types/development';
import { TYPE_LABEL, TYPES, useTeamParam } from './common';
import { BacklogList, type Place } from './components/BacklogList';
import { DefinitionsCard } from './components/DefinitionsCard';
import { MirrorCard } from './components/MirrorCard';
import { NewWorkItem } from './components/WorkItemForms';

export function BacklogPage() {
  const { user } = useSession();
  const navigate = useNavigate();
  const { team, picker, params, set } = useTeamParam({ allowNone: true });
  const [q, setQ] = useSearchText();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        {picker}
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
        {team && team !== 'none' && <aside><DefinitionsCard teamId={Number(team)} /><MirrorCard teamId={Number(team)} onChange={reload} /></aside>}
      </div>
      {creating && <NewWorkItem team={team ?? undefined} onClose={() => setCreating(false)} onDone={(ref) => navigate(`/work/${ref}`)} />}
    </>
  );
}
