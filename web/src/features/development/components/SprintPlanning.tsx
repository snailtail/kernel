// Sprint planning (#166): the sprint's items beside the top of the team's backlog. Drag an item across, or use its
// button (keyboard and touch); the sum of points is shown against the capacity, over it is a warning only.
import { useState, type DragEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../../../api/client';
import { useApi } from '../../../hooks';
import type { Sprint, WorkItemRow } from '../../../api/types/development';
import { TypeBadge } from '../common';

type Row = { ref: string; item_type: WorkItemRow['item_type']; title: string; points: number | null; assignee: string | null; unplanned?: boolean };

function ItemList({ label, rows, empty, action, onAction, onDrop }: {
  label: string; rows: Row[]; empty: string; action: string; onAction: (ref: string) => void; onDrop: (ref: string) => void;
}) {
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); const ref = e.dataTransfer.getData('text/plain'); if (ref) onDrop(ref); };
  return (
    <section className={`sp-plan-col${over ? ' over' : ''}`} aria-label={label} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
      <h3>{label} <span className="count">{rows.length}</span></h3>
      {rows.length === 0 && <p className="placeholder small">{empty}</p>}
      <ul className="wi-backlog">
        {rows.map((w) => (
          <li key={w.ref} className="wi-row" draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', w.ref); e.dataTransfer.effectAllowed = 'move'; }}>
            <span className="wi-grip" aria-hidden>⋮⋮</span>
            <span className="wi-main"><TypeBadge type={w.item_type} /> <Link to={`/work/${w.ref}`} className="wi-title">{w.title}</Link>{w.unplanned && <span className="tag">unplanned</span>}</span>
            <span className="wi-meta">
              <span className="wi-points small" title="Story points">{w.points ?? '–'}</span>
              <button type="button" className="btn small" onClick={() => onAction(w.ref)} aria-label={`${action} ${w.ref}`}>{action}</button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SprintPlanning({ sprint, onChanged }: { sprint: Sprint; onChanged: () => void }) {
  const { data: backlog, reload } = useApi<WorkItemRow[]>(`/api/work-items?team=${sprint.team_id}&sprint=none&limit=100`);
  const [error, setError] = useState<string | null>(null);
  const candidates = (backlog ?? []).filter((w) => w.item_type !== 'epic');
  const inSprint = new Set(sprint.work_items.map((w) => w.ref));
  const change = async (body: { add?: string[]; remove?: string[] }) => {
    setError(null);
    try {
      await api.post(`/api/sprints/${sprint.id}/items`, body);
    } catch (err) {
      setError((err as Error).message);
    }
    reload();
    onChanged();
  };
  const { scope } = sprint.points;
  const pct = sprint.capacity ? Math.min(100, Math.round((scope / sprint.capacity) * 100)) : 0;
  return (
    <section className="card">
      <h2>{sprint.status === 'planned' ? 'Sprint planning' : 'In the sprint'}</h2>
      <p className={`sp-capacity small${sprint.over_capacity ? ' warn' : ''}`}>
        <strong>{scope}</strong>{sprint.capacity ? ` of ${sprint.capacity}` : ''} points
        {sprint.capacity && <span className="wi-progress-bar sp-capacity-bar" aria-hidden><span style={{ width: `${pct}%` }} /></span>}
        {sprint.over_capacity && ' · over capacity: take something out, or agree to stretch'}
        {sprint.status === 'active' && ' · added now, an item counts as unplanned'}
      </p>
      {error && <div className="error">{error}</div>}
      <div className="sp-plan">
        <ItemList label="In the sprint" rows={sprint.work_items} empty="Drag items here from the backlog." action="Take out"
          onAction={(ref) => change({ remove: [ref] })} onDrop={(ref) => !inSprint.has(ref) && change({ add: [ref] })} />
        <ItemList label="Top of the backlog" rows={candidates} empty="Nothing left to plan." action="Add"
          onAction={(ref) => change({ add: [ref] })} onDrop={(ref) => inSprint.has(ref) && change({ remove: [ref] })} />
      </div>
    </section>
  );
}
