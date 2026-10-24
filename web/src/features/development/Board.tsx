// Development work (#166): a team's board. With an active sprint it shows the sprint's items; a Kanban team without
// one sees its open items, with WIP limits per column as a warning. Dragging a card, or its "Move…" menu, is a
// transition with the API's rules; moving to ready or done shows the team's definition first.
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api/client';
import { KanbanBoard } from '../../components/KanbanBoard';
import { formatDay } from '../../format';
import { useApi } from '../../hooks';
import { useLive } from '../../hooks/useLive';
import { canEdit, useSession } from '../../session';
import { WORK_ITEM_STATUS } from '../../statuses';
import type { Board, BoardCard, BoardColumn, WorkDefinitions } from '../../api/types/development';
import { DefinitionCheck, TYPE_LABEL, TYPES, TypeBadge, useTeamParam } from './common';

export function BoardPage() {
  const { user } = useSession();
  const { team, picker, params, set } = useTeamParam();
  const filters = new URLSearchParams([...params].filter(([k]) => ['type', 'assignee', 'label'].includes(k)));
  const { data, refresh } = useApi<Board>(team ? `/api/teams/${team}/board?${filters}` : null);
  const { data: defs } = useApi<WorkDefinitions>(team ? `/api/teams/${team}/work-definitions` : null);
  useLive(['work_item:*'], refresh);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<{ card: BoardCard; to: 'ready' | 'done' } | null>(null);
  const editable = canEdit(user);

  const transition = async (card: BoardCard, to: BoardColumn, checked?: string[]) => {
    setError(null);
    try {
      await api.post(`/api/work-items/${card.ref}/transition`, { to, ...(checked ? { checked } : {}) });
    } catch (err) {
      setError(`${card.ref}: ${(err as Error).message}`);
    }
    refresh();
  };
  const move = (card: BoardCard, to: BoardColumn) => {
    if (!card.transitions.includes(to)) return setError(`${card.ref} cannot go from ${WORK_ITEM_STATUS[card.status].toLowerCase()} to ${WORK_ITEM_STATUS[to].toLowerCase()}`);
    if ((to === 'ready' || to === 'done') && defs?.[to].length) return setChecking({ card, to });
    transition(card, to);
  };

  const items = data?.columns.flatMap((c) => c.items) ?? [];
  const column = (k: BoardColumn) => data?.columns.find((c) => c.status === k);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Board</h1>
          {data?.sprint ? (
            <p className="muted">
              <Link to={`/sprints/${data.sprint.id}`}>{data.sprint.name}</Link>, {formatDay(data.sprint.starts_on)} – {formatDay(data.sprint.ends_on)}{data.sprint.goal && <>: {data.sprint.goal}</>}
            </p>
          ) : (
            <p className="muted">No active sprint: the team&apos;s open items, Kanban style. <Link to={`/sprints?team=${team ?? ''}`}>Plan a sprint</Link> to work in sprints.</p>
          )}
        </div>
      </header>
      <div className="filters">
        {picker}
        <select value={params.get('type') ?? ''} onChange={(e) => set('type', e.target.value)} aria-label="Type">
          <option value="">Every type</option>{TYPES.filter((t) => t !== 'epic').map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <select value={params.get('assignee') ?? ''} onChange={(e) => set('assignee', e.target.value)} aria-label="Assignee">
          <option value="">Anyone</option><option value="me">Mine</option><option value="none">Unassigned</option>
        </select>
        <input className="label-filter" placeholder="Label" value={params.get('label') ?? ''} onChange={(e) => set('label', e.target.value.trim())} aria-label="Label" />
      </div>
      {error && <div className="error">{error}</div>}
      {data && (
        <KanbanBoard<BoardColumn, BoardCard> label={`${data.team} board`} columns={data.columns.map((c) => ({ key: c.status, label: WORK_ITEM_STATUS[c.status] }))}
          columnOf={(w) => w.status} items={items} editable={editable} onMove={move}
          columnNote={(k) => {
            const c = column(k);
            if (!c?.wip_limit) return null;
            return c.over_limit ? { text: `Over the WIP limit of ${c.wip_limit}`, warn: true } : { text: `WIP limit ${c.wip_limit}` };
          }}
          renderCard={(w) => (
            <>
              <Link to={`/work/${w.ref}`} className="kanban-title">{w.title}</Link>
              <div className="kanban-meta">
                <TypeBadge type={w.item_type} />
                <span className="mono small">{w.ref}</span>
                {w.points !== null && <span className="wi-points small" title="Story points">{w.points}</span>}
              </div>
            </>
          )}
          renderMeta={(w) => <span className="muted small">{w.assignee ?? 'Unassigned'}</span>} />
      )}
      {checking && defs && (
        <DefinitionCheck to={checking.to} items={defs[checking.to]} onClose={() => setChecking(null)}
          onConfirm={async (checked) => { await transition(checking.card, checking.to, checked); setChecking(null); }} />
      )}
    </>
  );
}
