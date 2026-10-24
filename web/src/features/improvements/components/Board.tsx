import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../../api/client';
import { KanbanBoard } from '../../../components/KanbanBoard';
import { IMPROVEMENT_STATUS, type ImprovementStatus } from '../../../statuses';
import type { ImprovementRow } from '../../../api/types/improvements';
import { STATUSES, rating, quadrantOf, transitionBody } from '../common';

/** Kanban by status. Dragging a card is a status change with the API's rules; each card also has a menu to move it. */
export function Board({ rows, editable, onChanged }: { rows: ImprovementRow[]; editable: boolean; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const move = async (row: ImprovementRow, to: ImprovementStatus) => {
    const body = await transitionBody(to);
    if (!body) return;
    setError(null);
    try {
      await api.post(`/api/improvements/${row.ref}/transition`, body);
    } catch (err) {
      setError(`${row.ref}: ${(err as Error).message}`);
    }
    onChanged();
  };
  return (
    <>
      {error && <div className="error">{error}</div>}
      <KanbanBoard label="Improvements by status" columns={STATUSES.map((s) => ({ key: s, label: IMPROVEMENT_STATUS[s] }))} columnOf={(m) => m.status}
        items={rows} editable={editable} onMove={move}
        renderCard={(m) => (
          <>
            <Link to={`/improvements/${m.ref}`} className="kanban-title">{m.title}</Link>
            <div className="kanban-meta">
              <span className="mono small">{m.ref}</span>
              <span className="small">{rating(m)}</span>
              {quadrantOf(m) === 'quick' && <span className="tag quick-win">quick win</span>}
            </div>
          </>
        )}
        renderMeta={(m) => <span className="muted small">{m.owner ?? 'No owner'}{m.service_name ? ` · ${m.service_name}` : ''}</span>} />
    </>
  );
}
