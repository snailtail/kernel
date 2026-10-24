import { useState, type DragEvent, type ReactNode } from 'react';

/**
 * A board of cards in columns (a status each): drag a card to another column, or use its "Move…" menu (keyboard and
 * touch). `onMove` does the move; the page reloads afterwards. `renderCard` draws a card's body, the menu goes below it.
 */
export function KanbanBoard<C extends string, T extends { ref: string }>({ label, columns, columnOf, items, editable, renderCard, renderMeta, columnNote, onMove }: {
  label: string;
  columns: { key: C; label: string }[];
  columnOf: (item: T) => C;
  items: T[];
  editable: boolean;
  renderCard: (item: T) => ReactNode;
  /** The card's last row, left of the "Move…" menu. */
  renderMeta?: (item: T) => ReactNode;
  /** A line under a column's heading, e.g. its WIP limit; `warn` marks the column. */
  columnNote?: (key: C, count: number) => { text: string; warn?: boolean } | null;
  onMove: (item: T, to: C) => void;
}) {
  const [over, setOver] = useState<C | null>(null);
  const move = (ref: string, to: C) => {
    const item = items.find((i) => i.ref === ref);
    if (item && columnOf(item) !== to) onMove(item, to);
  };
  const drop = (to: C) => (e: DragEvent) => { e.preventDefault(); setOver(null); const ref = e.dataTransfer.getData('text/plain'); if (ref) move(ref, to); };
  return (
    <div className="kanban" aria-label={label}>
      {columns.map((col) => {
        const cards = items.filter((i) => columnOf(i) === col.key);
        const note = columnNote?.(col.key, cards.length);
        return (
          <section key={col.key} className={`kanban-col${over === col.key ? ' over' : ''}${note?.warn ? ' warn' : ''}`} aria-label={col.label}
            onDragOver={editable ? (e) => { e.preventDefault(); setOver(col.key); } : undefined} onDragLeave={() => setOver(null)} onDrop={editable ? drop(col.key) : undefined}>
            <h2>{col.label} <span className="count">{cards.length}</span></h2>
            {note && <p className={`kanban-note small${note.warn ? ' warn' : ' muted'}`}>{note.text}</p>}
            {cards.map((item) => (
              <article key={item.ref} className="kanban-card" draggable={editable} onDragStart={(e) => { e.dataTransfer.setData('text/plain', item.ref); e.dataTransfer.effectAllowed = 'move'; }}>
                {renderCard(item)}
                <div className="kanban-meta">
                  {renderMeta?.(item)}
                  {editable && (
                    <select className="kanban-move" value="" aria-label={`Move ${item.ref}`} onChange={(e) => e.target.value && move(item.ref, e.target.value as C)}>
                      <option value="">Move…</option>
                      {columns.filter((t) => t.key !== col.key).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                    </select>
                  )}
                </div>
              </article>
            ))}
            {cards.length === 0 && <p className="placeholder small">{editable ? 'Drop a card here.' : 'Nothing here.'}</p>}
          </section>
        );
      })}
    </div>
  );
}
