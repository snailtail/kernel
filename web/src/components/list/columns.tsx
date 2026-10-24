import { useEffect, useState } from 'react';

// A view stores the visible columns; the choice is remembered per list in this browser. Cells carry data-col and the
// list's container lists the hidden ones in data-hide; styles.css has a rule per column (inline styles are not allowed
// by the Content Security Policy), and a test checks that every column below has one.

const COLUMN_KEYS = [
  'status', 'priority', 'sla', 'cis', 'assignee', 'problem', 'opened', 'service', 'age', 'updated', 'type', 'risk', 'window',
  'audience', 'used', 'helpful', 'env', 'criticality', 'team', 'sources', 'seen', 'host', 'source', 'count', 'incident',
] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

const COLUMNS_EVENT = 'kernel:list-columns';
const storageKey = (list: string) => `kernel:columns:${list}`;

export const columnStore = {
  get(list: string): string[] {
    try {
      return JSON.parse(localStorage.getItem(storageKey(list)) ?? '[]');
    } catch {
      return [];
    }
  },
  /** An empty list means the list's default columns. */
  set(list: string, columns: string[]) {
    try {
      if (columns.length) localStorage.setItem(storageKey(list), JSON.stringify(columns));
      else localStorage.removeItem(storageKey(list));
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
    window.dispatchEvent(new CustomEvent(COLUMNS_EVENT, { detail: { list, columns } }));
  },
};

export function useColumns(list: string, columns: { key: ColumnKey; label: string }[]) {
  const [visible, setVisible] = useState<string[]>(() => columnStore.get(list));
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ list: string; columns: string[] }>).detail;
      if (d.list === list) setVisible(d.columns);
    };
    window.addEventListener(COLUMNS_EVENT, on);
    return () => window.removeEventListener(COLUMNS_EVENT, on);
  }, [list]);
  const shown = visible.length ? visible : columns.map((c) => c.key);
  const hidden = columns.filter((c) => !shown.includes(c.key));
  const toggle = (key: string) => {
    const next = shown.includes(key) ? shown.filter((k) => k !== key) : columns.map((c) => c.key).filter((k) => k === key || shown.includes(k));
    columnStore.set(list, next.length === columns.length ? [] : next);
  };
  const picker = (
    <details className="column-picker">
      <summary className="btn small">Columns</summary>
      <div className="column-menu">
        {columns.map((c) => (
          <label key={c.key} className="check"><input type="checkbox" checked={shown.includes(c.key)} disabled={shown.length === 1 && shown.includes(c.key)} onChange={() => toggle(c.key)} /> {c.label}</label>
        ))}
        {visible.length > 0 && <button className="btn-link small" onClick={() => columnStore.set(list, [])}>Default columns</button>}
      </div>
    </details>
  );
  /** Spread on the element around the list. */
  const container = { 'data-hide': hidden.map((c) => c.key).join(' ') || undefined };
  return { picker, container };
}
