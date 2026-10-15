import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode, type TouchEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { applyUndo, previewUndo, runBulk, storms, type BulkResult, type ItemResult, type OpName, type Operation, type Practice } from '../bulk';
import { CLOSURE_LABEL, STATUS_LABEL } from '../format';
import { LIST_KEYS } from '../nav';
import { useTeams } from '../pages/Teams';
import { canEdit, useSession } from '../session';
import { Modal } from './Modal';
import type { ListName } from './SavedViews';

// The list toolkit (#110): select records with checkboxes (shift-click for a range, long-press on a phone), act on
// them in bulk through POST /api/<practice>/bulk, and triage with the keyboard (j/k, x, a, s, e). Every page list
// uses it; a bulk change is previewed, applied in chunks, reported per record and can be undone for 30 seconds.


export interface BulkSpec {
  practice: Practice;
  /** "incident", "incidents". */
  noun: [string, string];
  ops: OpName[];
  statuses?: Record<string, string>;
  /** "Owner" for actions and articles; teams only where records have one. */
  owner?: 'assignee' | 'owner';
  teams?: boolean;
}

const INCIDENT_STATUS = { new: 'New', in_progress: 'In progress', on_hold: 'On hold', resolved: 'Resolved', closed: 'Closed' };
const CHANGE_STATUS = { draft: 'Draft', assess: 'Assess', authorize: 'Authorise', scheduled: 'Scheduled', implementing: 'Implementing', review: 'Review', closed: 'Closed', rejected: 'Rejected', cancelled: 'Cancelled' };
const RESOLUTION = { fixed: 'Fixed', workaround: 'Workaround applied', problem_fixed: 'Fixed by problem resolution', no_fault_found: 'No fault found', duplicate: 'Duplicate', cancelled: 'Cancelled' };

/** What each list can do in bulk; the server checks the same per operation and role. */
export const BULK: Record<string, BulkSpec> = {
  incidents: { practice: 'incidents', noun: ['incident', 'incidents'], ops: ['assign', 'status', 'priority', 'link_problem', 'set_parent'], statuses: INCIDENT_STATUS, owner: 'assignee', teams: true },
  problems: { practice: 'problems', noun: ['problem', 'problems'], ops: ['assign', 'status', 'priority'], statuses: STATUS_LABEL, owner: 'assignee', teams: true },
  known_errors: { practice: 'problems', noun: ['known error', 'known errors'], ops: ['assign', 'status', 'priority'], statuses: STATUS_LABEL, owner: 'assignee', teams: true },
  changes: { practice: 'changes', noun: ['change', 'changes'], ops: ['assign', 'status'], statuses: CHANGE_STATUS, owner: 'assignee', teams: true },
  alerts: { practice: 'alerts', noun: ['alert', 'alerts'], ops: ['acknowledge', 'close'] },
  actions: { practice: 'actions', noun: ['action', 'actions'], ops: ['assign', 'status'], statuses: { open: 'Open', done: 'Done', cancelled: 'Cancelled' }, owner: 'owner' },
  knowledge: { practice: 'articles', noun: ['article', 'articles'], ops: ['assign', 'status'], statuses: { draft: 'Draft', published: 'Published', retired: 'Retired' }, owner: 'owner' },
  cis: { practice: 'cis', noun: ['CI', 'CIs'], ops: ['tags', 'status'], statuses: { planned: 'Planned', active: 'Active', maintenance: 'Maintenance', retired: 'Retired', missing: 'Missing' } },
};

const OP_LABEL: Record<OpName, string> = {
  assign: 'Assign', status: 'Status', priority: 'Priority', tags: 'Tags', link_problem: 'Link to problem', set_parent: 'Relate to incident', acknowledge: 'Acknowledge', close: 'Close',
};

const UNDO_SECONDS = 30;

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

  return { select, selectAll, rowProps, bar, selected, cursor };
}

function UndoToast({ toast, spec, onDone }: { toast: { text: string; undo: BulkResult['undo']; until: number }; spec: BulkSpec; onDone: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Teams the undo would page more than once: shown, and confirmed, before anything is sent.
  const [confirm, setConfirm] = useState<{ team: string; count: number }[] | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((toast.until - now) / 1000));
  useEffect(() => {
    if (left === 0 && !busy && !confirm && !error) onDone();
  }, [left, busy, confirm, error, onDone]);
  const run = async (confirmPaging: boolean) => {
    if (!toast.undo) return;
    setBusy(true);
    setError(null);
    try {
      if (!confirmPaging) {
        const many = storms(await previewUndo(api.post, spec.practice, toast.undo));
        if (many.length) {
          setConfirm(many);
          setBusy(false);
          return;
        }
      }
      const r = await applyUndo(api.post, spec.practice, toast.undo, confirmPaging);
      if (r.error) {
        setError(`Undone for ${r.summary.changed ?? 0} of ${toast.undo.items.length}: ${r.error}`);
        setBusy(false);
      } else onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="bulk-toast" role="status">
      <span>{toast.text}</span>
      {toast.undo && !confirm && <button className="btn small" disabled={busy || left === 0} onClick={() => run(false)}>Undo ({left}s)</button>}
      {confirm && (
        <>
          <label className="check small"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> Undo pages {confirm.map((p) => `${p.team} ${p.count} times`).join(' and ')}</label>
          <button className="btn small" disabled={!confirmed || busy} onClick={() => run(true)}>Undo anyway</button>
        </>
      )}
      {error && <span className="error small">{error}</span>}
      <button className="btn-link small" aria-label="Dismiss" onClick={onDone}>×</button>
    </div>
  );
}

/** "will be assigned to Network", "will move to Resolved"… */
function describe(spec: BulkSpec, operation: Operation, people: Map<number, string>, teams: Map<number, string>) {
  switch (operation.op) {
    case 'assign': {
      const parts: string[] = [];
      if (operation.team_id !== undefined) parts.push(operation.team_id === null ? 'no team' : `team ${teams.get(operation.team_id as number) ?? operation.team_id}`);
      if (operation.assignee_id !== undefined) parts.push(operation.assignee_id === null ? 'nobody' : people.get(operation.assignee_id as number) ?? 'the person chosen');
      return `will be assigned to ${parts.join(' and ')}`;
    }
    case 'status': return `will move to ${spec.statuses?.[operation.to as string] ?? operation.to}`;
    case 'priority': return `will get ${[operation.impact && `impact ${operation.impact}`, operation.urgency && `urgency ${operation.urgency}`].filter(Boolean).join(' and ')}`;
    case 'tags': return `will get tags ${[...(operation.add as string[]).map((t) => `+${t}`), ...(operation.remove as string[]).map((t) => `−${t}`)].join(' ')}`;
    case 'link_problem': return operation.problem ? `will be linked to ${operation.problem}` : 'will be unlinked from their problem';
    case 'set_parent': return `will be related to ${operation.parent}`;
    case 'acknowledge': return 'will be acknowledged';
    case 'close': return 'will be closed';
  }
}

function BulkDialog({ spec, op, ids, filter, onClose, onApplied }: {
  spec: BulkSpec; op: OpName; ids: string[] | null; filter: string; onClose: () => void; onApplied: (r: BulkResult, text: string) => void;
}) {
  const { meta } = useSession();
  const teams = useTeams();
  const [form, setForm] = useState<Record<string, string>>({ assignee: 'keep', team: 'keep', impact: '', urgency: '', to: '', add: '', remove: '', ref: '' });
  const [preview, setPreview] = useState<{ operation: Operation; result: BulkResult; ids: string[] } | null>(null);
  const [confirmPaging, setConfirmPaging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [done, setDone] = useState<BulkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const people = new Map(meta.assignees.map((a) => [a.id, a.display_name]));
  const teamNames = new Map(teams.map((t) => [t.id, t.name]));
  const owner = spec.owner === 'owner' ? 'Owner' : 'Assignee';

  const operation = (): Operation | string => {
    switch (op) {
      case 'assign': {
        const o: Operation = { op };
        if (form.assignee !== 'keep') o.assignee_id = form.assignee === 'none' ? null : Number(form.assignee);
        if (spec.teams && form.team !== 'keep') o.team_id = form.team === 'none' ? null : Number(form.team);
        return Object.keys(o).length > 1 ? o : `Choose ${spec.teams ? 'a team or a person' : 'an owner'}`;
      }
      case 'status': {
        if (!form.to) return 'Choose the status';
        const details: Record<string, string> = {};
        for (const k of ['comment', 'resolution_code', 'resolution', 'hold_reason', 'closure_code', 'root_cause', 'cancel_reason', 'note']) if (form[k]?.trim()) details[k] = form[k].trim();
        return { op, to: form.to, details };
      }
      case 'priority': {
        if (!form.impact && !form.urgency) return 'Choose impact or urgency';
        return { op, ...(form.impact ? { impact: Number(form.impact) } : {}), ...(form.urgency ? { urgency: Number(form.urgency) } : {}) };
      }
      case 'tags': {
        const split = (s: string) => s.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
        return split(form.add).length || split(form.remove).length ? { op, add: split(form.add), remove: split(form.remove) } : 'Give tags to add or remove';
      }
      case 'link_problem': return form.ref.trim() || form.unlink ? { op, problem: form.unlink ? null : form.ref.trim().toUpperCase() } : 'Give the problem, e.g. PRB000012';
      case 'set_parent': return form.ref.trim() ? { op, parent: form.ref.trim().toUpperCase() } : 'Give the incident to relate them to';
      default: return { op };
    }
  };

  const doPreview = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const o = operation();
    if (typeof o === 'string') return setError(o);
    try {
      // "All matching": the server resolves the filter once; the preview lists the records, which are then applied by id.
      const result = ids
        ? await runBulk(api.post, spec.practice, { ids }, { operation: o, dry_run: true })
        : await api.post<BulkResult>(`/api/${spec.practice}/bulk`, { filter, operation: o, dry_run: true });
      if (result.error) throw new Error(result.error);
      setPreview({ operation: o, result, ids: result.results.filter((r) => r.outcome === 'would_change').map((r) => r.id) });
      setConfirmPaging(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setError(null);
    setProgress(0);
    const result = await runBulk(api.post, spec.practice, { ids: preview.ids }, { operation: preview.operation, confirm_paging: confirmPaging }, setProgress);
    setProgress(null);
    // Nothing went through: stay on the preview with the reason. Otherwise show what was done, and keep its undo.
    if (result.error && !result.sent) setError(result.error);
    else setDone(result);
  };

  const noun = (n: number) => `${n} ${n === 1 ? spec.noun[0] : spec.noun[1]}`;
  const storm = preview?.result.pages.filter((p) => p.count > 1) ?? [];
  const problems = (r: BulkResult) => r.results.filter((x) => x.outcome === 'skipped' || x.outcome === 'failed');

  if (done) {
    const changed = done.summary.changed ?? 0;
    const text = `${noun(changed)} ${describe(spec, preview!.operation, people, teamNames).replace(/^will be /, '').replace(/^will /, '')}`;
    return (
      <Modal title={OP_LABEL[op]} onClose={() => onApplied(done, text)}>
        <div className="form">
          {done.error && <div className="error full" role="alert">Applied to {done.sent} of {preview!.ids.length}, then stopped: {done.error}</div>}
          <p className="full"><strong>{noun(changed)}</strong> changed{done.summary.unchanged ? `, ${done.summary.unchanged} already so` : ''}.</p>
          {done.pages.length > 0 && <p className="full hint">Paged: {done.pages.map((p) => `${p.team} (${p.count})`).join(', ')}.</p>}
          <Outcomes items={problems(done)} done />
          <div className="actions full">
            <button className="btn primary" onClick={() => onApplied(done, text)}>Done{done.undo ? ` (undo for ${UNDO_SECONDS}s)` : ''}</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`${OP_LABEL[op]}: ${ids ? noun(ids.length) : `all matching ${spec.noun[1]}`}`} onClose={onClose}>
      {!preview ? (
        <form className="form" onSubmit={doPreview}>
          {op === 'assign' && (
            <>
              {spec.teams && (
                <label>Team
                  <select value={form.team} onChange={set('team')}>
                    <option value="keep">Keep as is</option><option value="none">No team</option>
                    {teams.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </label>
              )}
              <label>{owner}
                <select value={form.assignee} onChange={set('assignee')}>
                  <option value="keep">Keep as is</option><option value="none">Nobody</option>
                  {meta.assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
                </select>
              </label>
            </>
          )}
          {op === 'status' && (
            <>
              <label className="full">New status
                <select value={form.to} onChange={set('to')} autoFocus>
                  <option value="">Choose…</option>
                  {Object.entries(spec.statuses ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              {spec.practice === 'incidents' && form.to === 'resolved' && (
                <>
                  <label>Resolution code
                    <select value={form.resolution_code ?? ''} onChange={set('resolution_code')}>
                      <option value="">Choose…</option>{Object.entries(RESOLUTION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </label>
                  <label className="full">How service was restored<textarea rows={2} value={form.resolution ?? ''} onChange={set('resolution')} /></label>
                </>
              )}
              {spec.practice === 'incidents' && form.to === 'on_hold' && <label className="full">Why on hold<input value={form.hold_reason ?? ''} onChange={set('hold_reason')} /></label>}
              {spec.practice === 'problems' && form.to === 'closed' && (
                <label>Closure code
                  <select value={form.closure_code ?? ''} onChange={set('closure_code')}>
                    <option value="">Choose…</option>{meta.closure_codes.map((c) => <option key={c} value={c}>{CLOSURE_LABEL[c] ?? c}</option>)}
                  </select>
                </label>
              )}
              {spec.practice === 'problems' && form.to === 'resolved' && <label className="full">Resolution<textarea rows={2} value={form.resolution ?? ''} onChange={set('resolution')} /></label>}
              {spec.practice === 'changes' && form.to === 'cancelled' && <label className="full">Why cancelled<input value={form.cancel_reason ?? ''} onChange={set('cancel_reason')} /></label>}
              {spec.practice === 'articles'
                ? <label className="full">Note <span className="muted small">(optional)</span><input value={form.note ?? ''} onChange={set('note')} /></label>
                : spec.practice !== 'actions' && <label className="full">Comment <span className="muted small">(optional, on each record)</span><input value={form.comment ?? ''} onChange={set('comment')} /></label>}
            </>
          )}
          {op === 'priority' && (
            <>
              <label>Impact<select value={form.impact} onChange={set('impact')}><option value="">Keep</option><option value="1">1 High</option><option value="2">2 Medium</option><option value="3">3 Low</option></select></label>
              <label>Urgency<select value={form.urgency} onChange={set('urgency')}><option value="">Keep</option><option value="1">1 High</option><option value="2">2 Medium</option><option value="3">3 Low</option></select></label>
            </>
          )}
          {op === 'tags' && (
            <>
              <label>Add tags<input value={form.add} onChange={set('add')} placeholder="edge, legacy" /></label>
              <label>Remove tags<input value={form.remove} onChange={set('remove')} /></label>
            </>
          )}
          {op === 'link_problem' && (
            <>
              <label>Problem<input value={form.ref} onChange={set('ref')} placeholder="PRB000012" disabled={!!form.unlink} /></label>
              <label className="check"><input type="checkbox" checked={!!form.unlink} onChange={(e) => setForm({ ...form, unlink: e.target.checked ? '1' : '' })} /> Unlink from their problem instead</label>
            </>
          )}
          {op === 'set_parent' && <label className="full">The incident they are part of<input value={form.ref} onChange={set('ref')} placeholder="INC000123" /></label>}
          {(op === 'acknowledge' || op === 'close') && <p className="hint full">{op === 'close' ? 'Closes the alerts by hand. A new event for the same check opens it again.' : 'Shows the others that someone is looking at these alerts.'}</p>}
          {error && <div className="error full" role="alert">{error}</div>}
          <div className="actions full">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary">Preview</button>
          </div>
        </form>
      ) : (
        <div className="form">
          {preview.ids.length ? (
            <p className="full bulk-preview">
              <strong>{noun(preview.ids.length)}</strong> {describe(spec, preview.operation, people, teamNames)}.
              {preview.result.summary.unchanged ? ` ${preview.result.summary.unchanged} already ${preview.result.summary.unchanged === 1 ? 'is' : 'are'}.` : ''}
            </p>
          ) : (
            <p className="full bulk-preview">Nothing to change{preview.result.summary.unchanged ? `: ${preview.result.summary.unchanged === 1 ? 'it already is' : `all ${preview.result.summary.unchanged} already are`}` : ''}.</p>
          )}
          <Outcomes items={problems(preview.result)} />
          {preview.result.pages.length > 0 && (
            <div className={`full ${storm.length ? 'warn-box' : 'hint'}`}>
              <p>This pages on-call: {preview.result.pages.map((p) => `${p.team} ${p.count === 1 ? 'once' : `${p.count} times`}`).join(', ')}.</p>
              {storm.length > 0 && (
                <label className="check"><input type="checkbox" checked={confirmPaging} onChange={(e) => setConfirmPaging(e.target.checked)} /> Yes, page {storm.map((p) => `${p.team} ${p.count} times`).join(' and ')}</label>
              )}
            </div>
          )}
          {progress !== null && <progress className="full" max={preview.ids.length} value={progress}>{progress} of {preview.ids.length}</progress>}
          {error && <div className="error full" role="alert">{error}</div>}
          <div className="actions full">
            <button className="btn" onClick={() => setPreview(null)} disabled={progress !== null}>Back</button>
            {preview.ids.length > 0 && (
              <button className="btn primary" onClick={apply} disabled={progress !== null || (storm.length > 0 && !confirmPaging)}>
                {progress !== null ? `Applying ${progress}/${preview.ids.length}…` : `Apply to ${noun(preview.ids.length)}`}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Outcomes({ items, done }: { items: ItemResult[]; done?: boolean }): ReactNode {
  if (!items.length) return null;
  return (
    <details className="full bulk-outcomes" open={items.length <= 5}>
      <summary>{items.length} {done ? 'not changed' : 'will not change'}</summary>
      <ul>
        {items.map((r) => (
          <li key={r.id}><span className="mono">{r.id}</span> {r.title && <span className="muted">{r.title}</span>} – {r.reason ?? r.outcome}</li>
        ))}
      </ul>
    </details>
  );
}

// ---- Columns ----------------------------------------------------------------------------------------------------
// A view stores the visible columns; the choice is remembered per list in this browser. Cells carry data-col and the
// list's container lists the hidden ones in data-hide; styles.css has a rule per column (inline styles are not allowed
// by the Content Security Policy), and a test checks that every column below has one.

export const COLUMN_KEYS = [
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

export type Toolkit<T> = ReturnType<typeof useListToolkit<T>>;
