import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { api, type Action, type Activity, type LinkKind, type ProblemDetail, type Status } from '../api';
import { MajorBadge, PriorityBadge, StatusBadge } from '../components/Badges';
import { ActionList, ActionModal } from '../components/Actions';
import { AnalysesSection } from '../components/Analyses';
import { GuidePanel } from '../components/Guide';
import { SimilarProblems } from '../components/Similar';
import { Modal } from '../components/Modal';
import {
  CLOSURE_LABEL, DECISION_LABEL, EFFECTIVENESS_LABEL, FIELD_LABEL, formatDate, formatDay, LEVEL_LABEL, LINK_LABEL, PRIORITY_LABEL, relativeTime, RISK_LABEL,
  NEXT_STATUS, STATUS_LABEL, STATUS_PHASE, TRANSITION_LABEL,
} from '../format';
import { useApi } from '../hooks';
import { canEdit, isManager, useSession } from '../session';

const LIFECYCLE: Status[] = ['new', 'analysis', 'known_error', 'resolved', 'closed'];

export function ProblemPage() {
  const { ref } = useParams();
  const { user, meta } = useSession();
  const { data: p, setData, error } = useApi<ProblemDetail>(`/api/problems/${ref}`);
  const [transition, setTransition] = useState<Status | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (error) return <div className="error">{error}</div>;
  if (!p) return null;

  const editable = canEdit(user) && p.status !== 'closed';
  const save = async (fields: Record<string, unknown>) => {
    setActionError(null);
    try {
      setData(await api.patch<ProblemDetail>(`/api/problems/${p.ref}`, fields));
    } catch (err) {
      setActionError((err as Error).message);
      throw err;
    }
  };

  const allowed = [...meta.transitions[p.status]].sort((a, b) => Number(b === NEXT_STATUS[p.status]) - Number(a === NEXT_STATUS[p.status])).filter((to) => {
    if (!canEdit(user)) return false;
    if ((to === 'closed' || p.status === 'closed') && !isManager(user)) return false;
    return true;
  });

  return (
    <>
      <header className="problem-head">
        <div className="crumbs"><Link to="/problems">Problems</Link> / <span className="mono">{p.ref}</span></div>
        <EditableTitle value={p.title} editable={editable} onSave={(title) => save({ title })} />
        <div className="badges">
          <StatusBadge status={p.status} />
          <PriorityBadge priority={p.priority} />
          {p.is_major && <MajorBadge />}
          <span className="muted">
            Logged by {p.created_by_name} {relativeTime(p.created_at)} · {p.detection === 'proactive' ? 'Proactive' : 'Reactive'}
          </span>
        </div>
        <ol className="lifecycle">
          {LIFECYCLE.map((s) => (
            <li key={s} className={s === p.status ? 'current' : LIFECYCLE.indexOf(s) < LIFECYCLE.indexOf(p.status) ? 'done' : ''}>
              <span className="step-name">{STATUS_LABEL[s]}</span>
              <span className="step-phase">{STATUS_PHASE[s]}</span>
            </li>
          ))}
        </ol>
        {allowed.length > 0 && (
          <div className="transitions">
            {allowed.map((to) => (
              <button key={to} className={`btn ${NEXT_STATUS[p.status] === to ? 'primary' : ''}`} onClick={() => setTransition(to)}>
                {LIFECYCLE.indexOf(to) < LIFECYCLE.indexOf(p.status) ? 'Reopen analysis' : TRANSITION_LABEL[to]}
              </button>
            ))}
          </div>
        )}
        {actionError && <div className="error">{actionError}</div>}
      </header>

      <div className="problem-grid">
        <div className="problem-main">
          <GuidePanel guidance={p.next_steps} />
          <TextSection title="Description" hint="Symptoms, scope and business impact" value={p.description} editable={editable} onSave={(v) => save({ description: v })} />
          {(p.status !== 'new' || p.analyses.length > 0) && <AnalysesSection problem={p} onChange={setData} />}
          <TextSection title="Root cause" hint="Findings from problem analysis" value={p.root_cause} editable={editable} onSave={(v) => save({ root_cause: v })} />
          <TextSection title="Workaround" hint="How to reduce or eliminate the impact until resolved" value={p.workaround} editable={editable} onSave={(v) => save({ workaround: v })} />
          {(p.known_error_at || p.status === 'known_error') && <ErrorControlSection problem={p} onChange={setData} />}
          <TextSection title="Resolution" hint="The permanent solution, usually implemented through a change" value={p.resolution} editable={editable} onSave={(v) => save({ resolution: v })} />
          {p.is_major && (
            <TextSection title="Major problem review" hint="What went well, what could be improved, how to prevent recurrence, follow-up actions"
              value={p.major_review} editable={editable} onSave={(v) => save({ major_review: v })} />
          )}
          <ActionsSection problem={p} onChange={setData} />
          <ActivitySection problem={p} onChange={setData} />
        </div>
        <aside className="problem-side">
          <DetailsPanel problem={p} editable={editable} onSave={save} />
          <LinksPanel problem={p} editable={canEdit(user)} onChange={setData} />
          <SimilarProblems text={`${p.title} ${p.description}`} exclude={p.ref} duplicateRef={isManager(user) && p.status !== 'closed' ? p.ref : undefined} />
        </aside>
      </div>

      {transition && (
        <TransitionModal problem={p} to={transition} onClose={() => setTransition(null)} onDone={(np) => { setData(np); setTransition(null); }} />
      )}
    </>
  );
}

function EditableTitle({ value, editable, onSave }: { value: string; editable: boolean; onSave: (v: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <h1 className={editable ? 'editable' : ''} onClick={() => editable && setDraft(value)} title={editable ? 'Click to edit' : undefined}>
        {value}
      </h1>
    );
  }
  const commit = async () => {
    if (draft.trim() && draft !== value) await onSave(draft.trim()).catch(() => {});
    setDraft(null);
  };
  return (
    <input className="title-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); }} />
  );
}

function TextSection(props: { title: string; hint: string; value: string; editable: boolean; onSave: (v: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const commit = async () => {
    setBusy(true);
    try {
      await props.onSave(draft ?? '');
      setDraft(null);
    } catch {
      /* error shown in page header */
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card text-section">
      <div className="section-head">
        <h2>{props.title}</h2>
        {props.editable && draft === null && <button className="btn-link" onClick={() => setDraft(props.value)}>Edit</button>}
      </div>
      {draft !== null ? (
        <>
          <textarea autoFocus rows={Math.max(5, draft.split('\n').length + 1)} value={draft} placeholder={props.hint} onChange={(e) => setDraft(e.target.value)} />
          <div className="actions">
            <button className="btn" onClick={() => setDraft(null)} disabled={busy}>Cancel</button>
            <button className="btn primary" onClick={commit} disabled={busy}>Save</button>
          </div>
        </>
      ) : props.value ? (
        <p className="prose">{props.value}</p>
      ) : (
        <p className="placeholder">{props.hint}</p>
      )}
    </section>
  );
}

function DetailsPanel({ problem: p, editable, onSave }: { problem: ProblemDetail; editable: boolean; onSave: (f: Record<string, unknown>) => Promise<void> }) {
  const { user, meta } = useSession();
  const [service, setService] = useState<string | null>(null);
  const field = (label: string, content: ReactNode) => (
    <>
      <dt>{label}</dt>
      <dd>{content}</dd>
    </>
  );
  const select = (key: string, value: string | number | null, options: [string | number, string][], allowEmpty?: string) =>
    editable ? (
      <select value={value ?? ''} onChange={(e) => onSave({ [key]: e.target.value === '' ? null : typeof value === 'number' || key.endsWith('_id') || key === 'impact' || key === 'urgency' ? Number(e.target.value) : e.target.value }).catch(() => {})}>
        {allowEmpty !== undefined && <option value="">{allowEmpty}</option>}
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    ) : (
      options.find(([v]) => v === value)?.[1] ?? allowEmpty ?? '–'
    );

  return (
    <section className="card details">
      <h2>Details</h2>
      <dl>
        {field('Assignee', select('assignee_id', p.assignee_id, meta.assignees.map((a) => [a.id, a.display_name]), 'Unassigned'))}
        {field('Category', select('category_id', p.category_id, meta.categories.filter((c) => c.active || c.id === p.category_id).map((c) => [c.id, c.name]), '–'))}
        {field('Service / CI', editable ? (
          <input value={service ?? p.affected_service} placeholder="–" onChange={(e) => setService(e.target.value)}
            onBlur={() => { if (service !== null && service !== p.affected_service) onSave({ affected_service: service }).catch(() => {}); setService(null); }} />
        ) : p.affected_service || '–')}
        {field('Detection', select('detection', p.detection, [['reactive', 'Reactive (incidents)'], ['proactive', 'Proactive (events, trends)']]))}
        {field('Impact', select('impact', p.impact, [1, 2, 3].map((l) => [l, `${l} – ${LEVEL_LABEL[l]}`])))}
        {field('Urgency', select('urgency', p.urgency, [1, 2, 3].map((l) => [l, `${l} – ${LEVEL_LABEL[l]}`])))}
        {field('Priority', <strong>P{p.priority} {PRIORITY_LABEL[p.priority]}</strong>)}
        {field('Major problem', editable && isManager(user) ? (
          <label className="check"><input type="checkbox" checked={p.is_major} onChange={(e) => onSave({ is_major: e.target.checked }).catch(() => {})} /> {p.is_major ? 'Yes' : 'No'}</label>
        ) : p.is_major ? 'Yes' : 'No')}
        {p.closure_code && field('Closure code', CLOSURE_LABEL[p.closure_code])}
      </dl>
      <dl className="dates">
        {field('Logged', formatDate(p.created_at))}
        {p.known_error_at && field('Known error', formatDate(p.known_error_at))}
        {p.resolved_at && field('Resolved', formatDate(p.resolved_at))}
        {p.closed_at && field('Closed', formatDate(p.closed_at))}
        {field('Updated', formatDate(p.updated_at))}
      </dl>
    </section>
  );
}

function LinksPanel({ problem: p, editable, onChange }: { problem: ProblemDetail; editable: boolean; onChange: (p: ProblemDetail) => void }) {
  const { meta } = useSession();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ kind: (p.detection === 'proactive' ? 'event' : 'incident') as LinkKind, reference: '', system: '', url: '', note: '' });
  const [error, setError] = useState<string | null>(null);
  const { data: systems } = useApi<{ id: number; name: string; url_templates: Record<string, string>; active: boolean }[]>(adding ? '/api/systems' : null);
  const templated = !!systems?.find((s) => s.name.toLowerCase() === form.system.toLowerCase())?.url_templates[form.kind];

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      onChange(await api.post<ProblemDetail>(`/api/problems/${p.ref}/links`, form));
      setForm((f) => ({ ...f, reference: '', url: '', note: '' }));
      setAdding(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (id: number) => {
    if (!confirm('Remove this link?')) return;
    try {
      onChange(await api.del<ProblemDetail>(`/api/problems/${p.ref}/links/${id}`));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="card links">
      <div className="section-head">
        <h2>Linked records</h2>
        {editable && !adding && <button className="btn-link" onClick={() => setAdding(true)}>+ Link</button>}
      </div>
      {adding && (
        <form className="link-form" onSubmit={add}>
          <div className="row">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as LinkKind })}>
              {meta.link_kinds.map((k) => <option key={k} value={k}>{LINK_LABEL[k]}</option>)}
            </select>
            <input required autoFocus placeholder="Reference, e.g. INC0012345" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </div>
          <input placeholder="System (ServiceNow, Jira, Zabbix…)" list="link-systems" value={form.system} onChange={(e) => setForm({ ...form, system: e.target.value })} />
          <datalist id="link-systems">{systems?.filter((s) => s.active).map((s) => <option key={s.id} value={s.name} />)}</datalist>
          <input type="url" placeholder={templated ? 'Link generated from the system template' : 'https://… (link to the record)'} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <input placeholder="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <div className="actions">
            <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn primary">Add link</button>
          </div>
        </form>
      )}
      {error && <div className="error">{error}</div>}
      {p.links.length === 0 && !adding && <p className="placeholder">No incidents, events or changes linked.</p>}
      {meta.link_kinds.map((kind) => {
        const items = p.links.filter((l) => l.kind === kind);
        if (!items.length) return null;
        return (
          <div key={kind} className="link-group">
            <h3>{LINK_LABEL[kind]}s <span className="count">{items.length}</span></h3>
            <ul>
              {items.map((l) => (
                <li key={l.id}>
                  <div className="link-main">
                    {l.url ? <a href={l.url} target="_blank" rel="noreferrer noopener" className="mono">{l.reference} ↗</a> : <span className="mono">{l.reference}</span>}
                    {l.system && <span className="tag">{l.system}</span>}
                    {editable && <button className="btn-icon small" onClick={() => remove(l.id)} aria-label="Remove link">×</button>}
                  </div>
                  {l.note && <div className="muted small">{l.note}</div>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function ErrorControlSection({ problem: p, onChange }: { problem: ProblemDetail; onChange: (p: ProblemDetail) => void }) {
  const { user } = useSession();
  const [editing, setEditing] = useState(false);
  const editable = canEdit(user) && p.status !== 'closed';
  const decision = p.ec_decision ?? 'pending';
  const empty = !p.ec_risk && !p.ec_fix_cost && !p.ec_decision_note && !p.ec_risk_level && !p.workaround_effectiveness;
  return (
    <section className="card error-control">
      <div className="section-head">
        <h2>Error control</h2>
        {editable && <button className="btn-link" onClick={() => setEditing(true)}>{empty ? 'Assess' : 'Edit'}</button>}
      </div>
      <div className="ec-chips">
        <span className={`badge decision-${decision}`}>{DECISION_LABEL[decision]}</span>
        {p.ec_risk_level && <span className={`badge risk-${p.ec_risk_level}`}>{RISK_LABEL[p.ec_risk_level]}</span>}
        {p.workaround_effectiveness && <span className={`badge eff-${p.workaround_effectiveness}`}>{EFFECTIVENESS_LABEL[p.workaround_effectiveness]}</span>}
        {p.ec_review_date && (
          <span className={`badge ${p.ec_review_due ? 'major' : 'neutral'}`}>{p.ec_review_due ? 'Review overdue' : 'Review'} {formatDay(p.ec_review_date)}</span>
        )}
      </div>
      {empty ? (
        <p className="placeholder">Assess the risk of not fixing this known error against the cost of a permanent fix, and record the decision.</p>
      ) : (
        <dl className="ec-grid">
          {p.ec_risk && (<><dt>Risk of not fixing</dt><dd className="prose">{p.ec_risk}</dd></>)}
          {p.ec_fix_cost && (<><dt>Cost of fixing</dt><dd className="prose">{p.ec_fix_cost}</dd></>)}
          {p.ec_decision_note && (<><dt>Rationale</dt><dd className="prose">{p.ec_decision_note}</dd></>)}
        </dl>
      )}
      {p.ec_decided_by_name && p.ec_decided_at && (
        <p className="muted small">Decided by {p.ec_decided_by_name} {relativeTime(p.ec_decided_at)}{p.workaround_reviewed_at ? ` · workaround reviewed ${relativeTime(p.workaround_reviewed_at)}` : ''}</p>
      )}
      {editing && <AssessmentModal problem={p} onClose={() => setEditing(false)} onDone={(np) => { onChange(np); setEditing(false); }} />}
    </section>
  );
}

function AssessmentModal({ problem: p, onClose, onDone }: { problem: ProblemDetail; onClose: () => void; onDone: (p: ProblemDetail) => void }) {
  const { user, meta } = useSession();
  const [form, setForm] = useState({
    ec_risk_level: p.ec_risk_level ? String(p.ec_risk_level) : '',
    ec_risk: p.ec_risk,
    ec_fix_cost: p.ec_fix_cost,
    ec_decision: p.ec_decision ?? '',
    ec_decision_note: p.ec_decision_note,
    ec_review_date: p.ec_review_date ?? '',
    workaround_effectiveness: p.workaround_effectiveness ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      onDone(await api.put<ProblemDetail>(`/api/problems/${p.ref}/assessment`, {
        ...form,
        ec_risk_level: form.ec_risk_level ? Number(form.ec_risk_level) : null,
        ec_decision: form.ec_decision || null,
        ec_review_date: form.ec_review_date || null,
        workaround_effectiveness: form.workaround_effectiveness || null,
      }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const managerOnly = (d: string) => (d === 'accept' || d === 'defer') && !isManager(user);
  return (
    <Modal title={`Error control – ${p.ref}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="hint full">Weigh the risk of living with this known error against the cost of a permanent fix. Accepting or deferring the risk is a decision for the problem manager.</p>
        <label>Risk of not fixing
          <select value={form.ec_risk_level} onChange={set('ec_risk_level')}>
            <option value="">Not assessed</option>
            {[1, 2, 3].map((l) => <option key={l} value={l}>{RISK_LABEL[l]}</option>)}
          </select>
        </label>
        <label>Workaround
          <select value={form.workaround_effectiveness} onChange={set('workaround_effectiveness')}>
            <option value="">Not reviewed</option>
            {meta.workaround_effectiveness.map((w) => <option key={w} value={w}>{EFFECTIVENESS_LABEL[w]}</option>)}
          </select>
        </label>
        <label className="full">Risk and impact if it recurs
          <textarea rows={3} value={form.ec_risk} onChange={set('ec_risk')} placeholder="How often, how many users, cost of applying the workaround each time" />
        </label>
        <label className="full">Cost of a permanent fix
          <textarea rows={3} value={form.ec_fix_cost} onChange={set('ec_fix_cost')} placeholder="Effort, vendor dependency, change risk" />
        </label>
        <label>Decision
          <select value={form.ec_decision} onChange={set('ec_decision')}>
            <option value="">–</option>
            {meta.ec_decisions.map((d) => <option key={d} value={d} disabled={managerOnly(d)}>{DECISION_LABEL[d]}{managerOnly(d) ? ' (problem manager)' : ''}</option>)}
          </select>
        </label>
        <label>Review date
          <input type="date" value={form.ec_review_date} onChange={set('ec_review_date')} />
        </label>
        <label className="full">Rationale
          <textarea rows={3} value={form.ec_decision_note} onChange={set('ec_decision_note')} />
        </label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">Save assessment</button>
        </div>
      </form>
    </Modal>
  );
}

function ActionsSection({ problem: p, onChange }: { problem: ProblemDetail; onChange: (p: ProblemDetail) => void }) {
  const { user } = useSession();
  const [editing, setEditing] = useState<Action | 'new' | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const open = p.actions.filter((a) => a.status === 'open');
  const closed = p.actions.filter((a) => a.status !== 'open');
  const editable = canEdit(user);
  return (
    <section className="card">
      <div className="section-head">
        <h2>Follow-up actions {open.length > 0 && <span className="count">{open.length} open</span>}</h2>
        {editable && <button className="btn-link" onClick={() => setEditing('new')}>+ Action</button>}
      </div>
      {p.actions.length === 0 && <p className="placeholder">No follow-up actions. Add actions for fixes, vendor follow-ups, monitoring or review outcomes.</p>}
      <ActionList actions={showClosed ? [...open, ...closed] : open} editable={editable} onChange={onChange} onEdit={setEditing} />
      {closed.length > 0 && (
        <button className="btn-link small" onClick={() => setShowClosed(!showClosed)}>
          {showClosed ? 'Hide' : 'Show'} {closed.length} completed or cancelled
        </button>
      )}
      {editing && (
        <ActionModal refId={p.ref} action={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={(np) => { onChange(np); setEditing(null); }} />
      )}
    </section>
  );
}

function ActivitySection({ problem: p, onChange }: { problem: ProblemDetail; onChange: (p: ProblemDetail) => void }) {
  const { user } = useSession();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'comments'>('all');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onChange(await api.post<ProblemDetail>(`/api/problems/${p.ref}/comments`, { body }));
      setBody('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const items = filter === 'comments' ? p.activity.filter((a) => a.kind === 'comment' || (a.kind === 'status' && a.body)) : p.activity;

  return (
    <section className="card">
      <div className="section-head">
        <h2>Work notes &amp; history</h2>
        <div className="toggle">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button>
          <button className={filter === 'comments' ? 'on' : ''} onClick={() => setFilter('comments')}>Notes</button>
        </div>
      </div>
      {canEdit(user) && (
        <form onSubmit={submit} className="comment-form">
          <textarea rows={3} placeholder="Add a work note: findings, analysis steps, decisions…" value={body} onChange={(e) => setBody(e.target.value)} />
          {error && <div className="error">{error}</div>}
          <div className="actions">
            <button className="btn primary" disabled={busy || !body.trim()}>Add note</button>
          </div>
        </form>
      )}
      <ul className="activity">
        {items.map((a) => <li key={a.id}><ActivityLine activity={a} /></li>)}
      </ul>
    </section>
  );
}

export function ActivityLine({ activity: a }: { activity: Activity }) {
  let text: ReactNode;
  switch (a.kind) {
    case 'created':
      text = 'logged the problem';
      break;
    case 'comment':
      text = 'added a note';
      break;
    case 'status':
      text = (
        <>
          moved it from <strong>{STATUS_LABEL[a.data.from as Status]}</strong> to <strong>{STATUS_LABEL[a.data.to as Status]}</strong>
          {a.data.closure_code && <> ({CLOSURE_LABEL[a.data.closure_code]})</>}
        </>
      );
      break;
    case 'update':
      text = `updated ${Object.keys(a.data).map((k) => FIELD_LABEL[k] ?? k).join(', ')}`;
      break;
    case 'link':
    case 'action':
    case 'analysis':
    case 'assessment':
      text = a.body.charAt(0).toLowerCase() + a.body.slice(1);
      break;
  }
  return (
    <div className={`activity-item kind-${a.kind}`}>
      <div className="activity-head">
        <strong>{a.user_name ?? 'System'}</strong> {text}
        <time title={formatDate(a.created_at)}>{relativeTime(a.created_at)}</time>
      </div>
      {(a.kind === 'comment' || (a.kind === 'status' && a.body)) && <p className="prose activity-body">{a.body}</p>}
    </div>
  );
}

function TransitionModal({ problem: p, to, onClose, onDone }: { problem: ProblemDetail; to: Status; onClose: () => void; onDone: (p: ProblemDetail) => void }) {
  const { meta } = useSession();
  const [form, setForm] = useState({
    root_cause: p.root_cause,
    workaround: p.workaround,
    resolution: p.resolution,
    major_review: p.major_review,
    closure_code: to === 'closed' ? (p.status === 'resolved' ? 'resolved' : p.status === 'new' ? 'duplicate' : '') : '',
    comment: '',
  });
  const [acknowledge, setAcknowledge] = useState(false);
  const openActions = p.actions.filter((a) => a.status === 'open').length;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const reopen = LIFECYCLE.indexOf(to) < LIFECYCLE.indexOf(p.status);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { to, comment: form.comment || undefined };
    if (to === 'known_error') Object.assign(body, { root_cause: form.root_cause, workaround: form.workaround });
    if (to === 'resolved') Object.assign(body, { resolution: form.resolution });
    if (to === 'closed') {
      Object.assign(body, { closure_code: form.closure_code || undefined, acknowledge_open_actions: acknowledge || undefined });
      if (p.is_major) body.major_review = form.major_review;
    }
    try {
      onDone(await api.post<ProblemDetail>(`/api/problems/${p.ref}/transition`, body));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const title = reopen ? 'Reopen analysis' : TRANSITION_LABEL[to];
  return (
    <Modal title={`${title} – ${p.ref}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {to === 'known_error' && (
          <>
            <p className="hint full">Error control: the problem has been analysed. Document the root cause and any workaround so it is available in the known error database.</p>
            <label className="full">Root cause <span className="req">required</span><textarea required rows={5} value={form.root_cause} onChange={set('root_cause')} /></label>
            <label className="full">Workaround<textarea rows={4} value={form.workaround} onChange={set('workaround')} /></label>
          </>
        )}
        {to === 'resolved' && (
          <label className="full">Resolution <span className="req">required</span>
            <textarea required rows={5} value={form.resolution} onChange={set('resolution')} placeholder="The permanent solution. Link the implementing change under Linked records." />
          </label>
        )}
        {to === 'closed' && (
          <>
            <label className="full">Closure code <span className="req">required</span>
              <select required value={form.closure_code} onChange={set('closure_code')}>
                <option value="">Choose…</option>
                {meta.closure_codes.map((c) => <option key={c} value={c}>{CLOSURE_LABEL[c]}</option>)}
              </select>
            </label>
            {form.closure_code === 'no_fix' && p.ec_decision !== 'accept' && (
              <p className="warn-box full">Closing without a fix requires an accepted risk. Record the decision under Error control first.</p>
            )}
            {p.is_major && form.closure_code !== 'duplicate' && form.closure_code !== 'cancelled' && (
              <label className="full">Major problem review <span className="req">required</span>
                <textarea required rows={6} value={form.major_review} onChange={set('major_review')}
                  placeholder="What went well, what could be improved, how to prevent recurrence, follow-up actions" />
              </label>
            )}
            {openActions > 0 && (
              <label className="check full warn-box">
                <input type="checkbox" required checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />
                {openActions} follow-up action{openActions > 1 ? 's are' : ' is'} still open. Close the problem anyway.
              </label>
            )}
          </>
        )}
        <label className="full">
          {reopen ? 'Reason for reopening' : 'Comment'}
          <textarea rows={3} value={form.comment} onChange={set('comment')} required={reopen} />
        </label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{title}</button>
        </div>
      </form>
    </Modal>
  );
}
