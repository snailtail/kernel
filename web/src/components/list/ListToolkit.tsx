import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type TouchEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { BulkResult, OpName } from '../../bulk';
import { LIST_KEYS } from '../../nav';
import { canEdit, useSession } from '../../session';
import type { ListName } from '../SavedViews';
import { BULK, OP_LABEL, UNDO_SECONDS } from './bulk';
import { BulkDialog, UndoToast } from './BulkDialog';

// The list toolkit (#110): select records with checkboxes (shift-click for a range, long-press on a phone), act on
// them in bulk through POST /api/<practice>/bulk, and triage with the keyboard (j/k, x, a, s, e). Every page list
// uses it; a bulk change is previewed, applied in chunks, reported per record and can be undone for 30 seconds.

interface Options<T> {
  list: ListName;
  rows: T[] | null | undefined;
  idOf: (row: T) => string;
  hrefOf?: (row: T) => string;
  /** The list's current query string, for "select all matching". */
  filter?: string;
  /** Rows the list shows at most (its limit), to offer "select all matching" when it is full. */
  pageSize?: number;
  onChanged: () => void;
}

/**
 * Selection, keyboard triage and the bulk bar for a list. Render `bar` once, `selectAll` in the header and
 * `select(row, index)` plus `rowProps(row, index)` on each row.
 */
export function useListToolkit<T>({ list, rows, idOf, hrefOf, filter = '', pageSize = 200, onChanged }: Options<T>) {
  const { user } = useSession();
  const spec = canEdit(user) ? BULK[list] : undefined;
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const [dialog, setDialog] = useState<OpName | null>(null);
  const anchor = useRef<number | null>(null);
  const ids = useMemo(() => (rows ?? []).map(idOf), [rows, idOf]);

  // A new filter is a new list: start over.
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
    setCursor(-1);
  }, [filter]);
  // Rows that went away (closed, moved by someone else) are no longer selected.
  useEffect(() => {
    setSelected((s) => (([...s].every((id) => ids.includes(id))) ? s : new Set([...s].filter((id) => ids.includes(id)))));
  }, [ids]);

  const toggle = useCallback((index: number, range = false) => {
    const id = ids[index];
    if (id === undefined) return;
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      const on = !prev.has(id);
      if (range && anchor.current !== null) {
        const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
        for (const x of ids.slice(a, b + 1)) on ? next.add(x) : next.delete(x);
      } else if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    anchor.current = index;
  }, [ids]);

  const target = selected.size ? [...selected] : cursor >= 0 && ids[cursor] ? [ids[cursor]] : [];
  const open = (op: OpName) => spec?.ops.includes(op) && (target.length || allMatching) && setDialog(op);

  // Keyboard triage. Ignored while typing, in a dialog, or after "g" (that is "go to…", see nav.ts).
  const keys = useRef({ open, toggle, cursor, rows, hrefOf, navigate });
  keys.current = { open, toggle, cursor, rows, hrefOf, navigate };
  useEffect(() => {
    let lastG = 0;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.isContentEditable || ['TEXTAREA', 'SELECT'].includes(t.tagName) || (t.tagName === 'INPUT' && !['checkbox', 'radio'].includes((t as HTMLInputElement).type));
      if (e.ctrlKey || e.metaKey || e.altKey || typing || document.querySelector('.modal')) return;
      if (e.key === 'g') { lastG = Date.now(); return; }
      if (Date.now() - lastG < 1200) { lastG = 0; return; }
      const k = keys.current;
      const count = k.rows?.length ?? 0;
      const move = (to: number) => {
        setCursor(to);
        document.querySelector(`[data-row-index="${to}"]`)?.scrollIntoView({ block: 'nearest' });
      };
      if (e.key === LIST_KEYS.down.key && count) move(Math.min(k.cursor + 1, count - 1));
      else if (e.key === LIST_KEYS.up.key && count) move(Math.max(k.cursor - 1, 0));
      else if (e.key === LIST_KEYS.select.key && k.cursor >= 0) k.toggle(k.cursor);
      else if (e.key === LIST_KEYS.assign.key) k.open('assign');
      else if (e.key === LIST_KEYS.status.key) k.open('status');
      else if ((e.key === LIST_KEYS.open.key || e.key === 'Enter') && k.cursor >= 0 && k.hrefOf && k.rows?.[k.cursor]) k.navigate(k.hrefOf(k.rows[k.cursor]));
      else if (e.key === 'Escape') { setSelected(new Set()); setAllMatching(false); }
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Long-press selects on a phone; once something is selected, a tap on a row's checkbox adds to it.
  const press = useRef<{ timer: number; index: number } | null>(null);
  const rowProps = (row: T, index: number) => {
    const id = idOf(row);
    return {
      'data-row-index': index,
      'aria-selected': selected.has(id) || undefined,
      className: `${selected.has(id) || allMatching ? 'row-selected' : ''} ${index === cursor ? 'row-cursor' : ''}`.trim() || undefined,
      onTouchStart: spec ? (e: TouchEvent) => {
        if ((e.target as HTMLElement).closest('a, button, input, select')) return;
        press.current = { index, timer: window.setTimeout(() => { toggle(index); navigator.vibrate?.(15); press.current = null; }, 500) };
      } : undefined,
      onTouchEnd: () => { if (press.current) { clearTimeout(press.current.timer); press.current = null; } },
      onTouchMove: () => { if (press.current) { clearTimeout(press.current.timer); press.current = null; } },
    };
  };

  const select = (row: T, index: number) =>
    spec ? (
      <input
        type="checkbox"
        className="row-check"
        aria-label={`Select ${idOf(row)}`}
        checked={allMatching || selected.has(idOf(row))}
        onChange={() => undefined}
        onClick={(e: MouseEvent<HTMLInputElement>) => toggle(index, e.shiftKey)}
      />
    ) : null;

  const allVisible = ids.length > 0 && ids.every((id) => selected.has(id));
  const selectAll = spec ? (
    <input
      type="checkbox"
      className="row-check"
      aria-label="Select all shown"
      checked={allVisible || allMatching}
      ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allVisible && !allMatching; }}
      onChange={() => { setAllMatching(false); setSelected(allVisible ? new Set() : new Set(ids)); }}
    />
  ) : null;

  const [toast, setToast] = useState<{ text: string; undo: BulkResult['undo']; until: number } | null>(null);
  const count = allMatching ? null : selected.size;
  const bar = spec ? (
    <>
      {(selected.size > 0 || allMatching) && (
        <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
          <span className="bulk-count">
            {allMatching ? `All ${spec.noun[1]} matching the filter` : `${count} ${count === 1 ? spec.noun[0] : spec.noun[1]} selected`}
          </span>
          {allVisible && !allMatching && ids.length >= pageSize && (
            <button className="btn-link small" onClick={() => setAllMatching(true)}>Select all matching</button>
          )}
          <span className="spacer" />
          {spec.ops.map((op) => (
            <button key={op} className="btn small" onClick={() => setDialog(op)}>
              {OP_LABEL[op]}
              {op === 'assign' && <kbd>{LIST_KEYS.assign.key}</kbd>}
              {op === 'status' && <kbd>{LIST_KEYS.status.key}</kbd>}
            </button>
          ))}
          <button className="btn-link small" onClick={() => { setSelected(new Set()); setAllMatching(false); }}>Clear</button>
        </div>
      )}
      {toast && <UndoToast toast={toast} spec={spec} onDone={() => { setToast(null); onChanged(); }} />}
      {dialog && (
        <BulkDialog
          spec={spec}
          op={dialog}
          ids={allMatching ? null : target}
          filter={filter}
          onClose={() => setDialog(null)}
          onApplied={(result, text) => {
            setDialog(null);
            setSelected(new Set());
            setAllMatching(false);
            onChanged();
            setToast({ text, undo: result.undo, until: Date.now() + UNDO_SECONDS * 1000 });
          }}
        />
      )}
    </>
  ) : null;

  // A summary notification links to the records one bulk change touched (#125): say so, and how to get the list back.
  const location = useLocation();
  const scope = new URLSearchParams(filter).has('bulk') ? (
    <p className="bulk-scope">
      Showing only the {BULK[list]?.noun[1] ?? 'records'} changed by one bulk change. <Link to={location.pathname}>Show the whole list</Link>
    </p>
  ) : null;

  return { select, selectAll, rowProps, bar, scope, selected, cursor };
}

export type Toolkit<T> = ReturnType<typeof useListToolkit<T>>;
