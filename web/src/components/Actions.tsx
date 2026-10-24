import { useState } from 'react';
import { Link } from 'react-router';
import { api, type Action } from '../api';
import { daysUntil, formatDay } from '../format';
import type { Toolkit } from './list/ListToolkit';
import { FormModal } from './Modal';
import { useSession } from '../session';

function DueLabel({ action }: { action: Action }) {
  if (!action.due_date) return <span className="muted">No due date</span>;
  if (action.status !== 'open') return <span className="muted">{formatDay(action.due_date)}</span>;
  const days = daysUntil(action.due_date);
  const label = days < 0 ? `${-days} d overdue` : days === 0 ? 'Due today' : days <= 7 ? `Due in ${days} d` : formatDay(action.due_date);
  return <span className={`due ${days < 0 ? 'overdue' : days <= 2 ? 'soon' : ''}`} title={formatDay(action.due_date)}>{label}</span>;
}

/** A list of follow-up actions with a completion checkbox. Set showParent in lists across records. */
export function ActionList({
  actions,
  editable,
  showParent,
  onChange,
  onEdit,
  toolkit,
}: {
  actions: Action[];
  editable: boolean;
  showParent?: boolean;
  onChange: () => void;
  onEdit?: (a: Action) => void;
  /** Selection and bulk changes in cross-problem lists (#110). */
  toolkit?: Toolkit<Action>;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const toggle = async (a: Action) => {
    setBusy(a.id);
    try {
      await api.patch<Action>(`/api/actions/${a.id}`, { status: a.status === 'open' ? 'done' : 'open' });
      onChange();
    } finally {
      setBusy(null);
    }
  };
  return (
    <ul className="action-list">
      {actions.map((a, n) => {
        const row = toolkit?.rowProps(a, n);
        return (
        <li key={a.id} {...row} className={[`action status-${a.status}`, row?.className].filter(Boolean).join(' ')}>
          <input
            type="checkbox"
            aria-label={a.status === 'open' ? 'Mark done' : 'Reopen'}
            checked={a.status !== 'open'}
            disabled={!editable || busy === a.id || a.status === 'cancelled'}
            onChange={() => toggle(a)}
          />
          <div className="action-body">
            <div className="action-title">
              {onEdit && editable ? <button className="btn-text" onClick={() => onEdit(a)}>{a.title}</button> : a.title}
              {a.status === 'cancelled' && <span className="tag">Cancelled</span>}
              {a.change_ref && <span className="tag mono">{a.change_ref}</span>}
            </div>
            <div className="action-meta">
              {showParent && (
                <Link to={a.path} className="action-problem"><span className="mono">{a.ref}</span> {a.parent_title}</Link>
              )}
              <span>{a.owner ?? 'No owner'}</span>
              <DueLabel action={a} />
            </div>
          </div>
          {/* Selecting sits at the end, apart from the box that marks the action done. */}
          {toolkit && <span className="action-select" title="Select for a bulk change">{toolkit.select(a, n)}</span>}
        </li>
        );
      })}
    </ul>
  );
}

/** Adds an action to the record `parent` (a ref), or edits one. */
function ActionModal({ parent, action, onClose, onDone }: { parent: string; action: Action | null; onClose: () => void; onDone: () => void }) {
  const { meta } = useSession();
  const [form, setForm] = useState({
    title: action?.title ?? '',
    description: action?.description ?? '',
    owner_id: action?.owner_id ? String(action.owner_id) : '',
    due_date: action?.due_date ?? '',
    change_ref: action?.change_ref ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const body = () => ({ ...form, owner_id: form.owner_id ? Number(form.owner_id) : null, due_date: form.due_date || null });

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const submit = async () => {
    await (action
      ? api.patch<Action>(`/api/actions/${action.id}`, body())
      : api.post<Action>('/api/actions', { ...body(), parent }));
    onDone();
  };

  return (
    <FormModal title={action ? 'Edit action' : 'Add follow-up action'} submitLabel={action ? 'Save' : 'Add action'} cancelLabel="Close" onClose={onClose} onSubmit={submit}
      actions={<>
        {action && action.status !== 'cancelled' && (
          <button type="button" className="btn-link danger spacer-right" onClick={() => run(() => api.patch(`/api/actions/${action.id}`, { status: 'cancelled' }))}>
            Cancel action
          </button>
        )}
        {action && action.status === 'cancelled' && (
          <button type="button" className="btn-link spacer-right" onClick={() => run(() => api.patch(`/api/actions/${action.id}`, { status: 'open' }))}>
            Reopen action
          </button>
        )}
      </>}>
      <label className="full">What needs to be done
        <input autoFocus required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="E.g. Vendor to deliver patch for connection leak" />
      </label>
      <label>Owner
        <select value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })}>
          <option value="">No owner</option>
          {meta.assignees.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
        </select>
      </label>
      <label>Due date
        <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
      </label>
      <label>Change reference
        <input value={form.change_ref} onChange={(e) => setForm({ ...form, change_ref: e.target.value })} placeholder="CHG0042" />
      </label>
      <label className="full">Details
        <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </label>
      {error && <div className="error full">{error}</div>}
    </FormModal>
  );
}

/** The follow-up actions of one record (#184): open first, the rest behind a toggle, and the add and edit dialog. */
export function ActionsCard({ parent, actions, editable, onChanged, placeholder }: {
  parent: string; actions: Action[]; editable: boolean; onChanged: () => void; placeholder: string;
}) {
  const [editing, setEditing] = useState<Action | 'new' | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const open = actions.filter((a) => a.status === 'open');
  const closed = actions.filter((a) => a.status !== 'open');
  return (
    <section className="card">
      <div className="section-head">
        <h2>Follow-up actions {open.length > 0 && <span className="count">{open.length} open</span>}</h2>
        {editable && <button className="btn-link" onClick={() => setEditing('new')}>+ Action</button>}
      </div>
      {actions.length === 0 && <p className="placeholder">{placeholder}</p>}
      <ActionList actions={showClosed ? [...open, ...closed] : open} editable={editable} onChange={onChanged} onEdit={setEditing} />
      {closed.length > 0 && (
        <button className="btn-link small" onClick={() => setShowClosed(!showClosed)}>
          {showClosed ? 'Hide' : 'Show'} {closed.length} completed or cancelled
        </button>
      )}
      {editing && (
        <ActionModal parent={parent} action={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => { onChanged(); setEditing(null); }} />
      )}
    </section>
  );
}
