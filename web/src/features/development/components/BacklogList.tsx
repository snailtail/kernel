import { useEffect, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { StatusBadge } from '../../../components/Badges';
import type { WorkItemRow } from '../../../api/types/development';
import { ProgressBar, TypeBadge } from '../common';

export type Place = { before: string } | { after: string } | { position: 'top' | 'bottom' };

/**
 * One team's backlog in rank order. Drag a row onto another to put it there, or use the keyboard: Alt+↑ and Alt+↓
 * move the focused row, Alt+Home to the top; the buttons do the same for touch. `onMove` asks the server, the list
 * shows the new order at once.
 */
export function BacklogList({ rows, movable, onMove }: { rows: WorkItemRow[]; movable: boolean; onMove: (ref: string, place: Place) => Promise<void> }) {
  const [order, setOrder] = useState(rows);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ ref: string; after: boolean } | null>(null);
  useEffect(() => setOrder(rows), [rows]);

  const move = async (ref: string, place: Place) => {
    const from = order.find((r) => r.ref === ref)!;
    const rest = order.filter((r) => r.ref !== ref);
    const at = 'position' in place ? (place.position === 'top' ? 0 : rest.length) : rest.findIndex((r) => r.ref === ('before' in place ? place.before : place.after)) + ('after' in place ? 1 : 0);
    setOrder([...rest.slice(0, at), from, ...rest.slice(at)]);
    await onMove(ref, place);
    requestAnimationFrame(() => document.getElementById(`wi-row-${ref}`)?.focus());
  };
  const step = (i: number, by: -1 | 1) => {
    const other = order[i + by];
    if (other) void move(order[i].ref, by < 0 ? { before: other.ref } : { after: other.ref });
  };
  const keys = (i: number) => (e: KeyboardEvent) => {
    if (!movable || !e.altKey) return;
    if (e.key === 'ArrowUp') step(i, -1);
    else if (e.key === 'ArrowDown') step(i, 1);
    else if (e.key === 'Home') void move(order[i].ref, { position: 'top' });
    else if (e.key === 'End') void move(order[i].ref, { position: 'bottom' });
    else return;
    e.preventDefault();
  };
  const dropOn = (target: WorkItemRow) => (e: DragEvent) => {
    e.preventDefault();
    const ref = e.dataTransfer.getData('text/plain');
    const after = over?.after ?? false;
    setOver(null);
    setDragging(null);
    if (ref && ref !== target.ref) void move(ref, after ? { after: target.ref } : { before: target.ref });
  };

  if (!order.length) return <p className="placeholder">Nothing in this backlog. Add a story, a bug or a task.</p>;
  return (
    <ol className="wi-backlog" aria-label="Backlog, in order">
      {order.map((w, i) => (
        <li key={w.ref} id={`wi-row-${w.ref}`} tabIndex={0} onKeyDown={keys(i)}
          className={`wi-row${dragging === w.ref ? ' dragging' : ''}${over?.ref === w.ref ? (over.after ? ' drop-after' : ' drop-before') : ''}`}
          draggable={movable} onDragStart={(e) => { e.dataTransfer.setData('text/plain', w.ref); e.dataTransfer.effectAllowed = 'move'; setDragging(w.ref); }}
          onDragEnd={() => { setDragging(null); setOver(null); }}
          onDragOver={movable ? (e) => { e.preventDefault(); const box = e.currentTarget.getBoundingClientRect(); setOver({ ref: w.ref, after: e.clientY > box.top + box.height / 2 }); } : undefined}
          onDrop={movable ? dropOn(w) : undefined}
          aria-label={`${i + 1}. ${w.ref} ${w.title}`}>
          {movable && <span className="wi-grip" aria-hidden>⋮⋮</span>}
          <span className="wi-pos muted small">{i + 1}</span>
          <TypeBadge type={w.item_type} />
          <span className="wi-main">
            <Link to={`/work/${w.ref}`} className="mono">{w.ref}</Link> <Link to={`/work/${w.ref}`} className="wi-title">{w.title}</Link>
            {w.parent_ref && <span className="muted small"> · in <Link to={`/work/${w.parent_ref}`}>{w.parent_title ?? w.parent_ref}</Link></span>}
            {w.labels.map((l) => <span key={l} className="tag small">{l}</span>)}
          </span>
          {w.progress && <ProgressBar p={w.progress} />}
          <span className="wi-meta">
            <StatusBadge kind="work_item" status={w.status} />
            <span className="wi-points" title="Story points">{w.points ?? '–'}</span>
            <span className="muted small wi-assignee">{w.assignee ?? 'Unassigned'}</span>
          </span>
          {movable && (
            <span className="wi-move">
              <button className="btn-link small" disabled={i === 0} onClick={() => move(w.ref, { position: 'top' })} aria-label={`Move ${w.ref} to the top`} title="To the top (Alt+Home)">⤒</button>
              <button className="btn-link small" disabled={i === 0} onClick={() => step(i, -1)} aria-label={`Move ${w.ref} up`} title="Up (Alt+↑)">↑</button>
              <button className="btn-link small" disabled={i === order.length - 1} onClick={() => step(i, 1)} aria-label={`Move ${w.ref} down`} title="Down (Alt+↓)">↓</button>
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
