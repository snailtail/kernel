import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, asConflict, type Conflict, type LinkKind, type ProblemDetail, type Status } from '../../api/client';
import { MajorBadge, PersonalDataBadge, PriorityBadge, StatusBadge } from '../../components/Badges';
import { ActionsCard } from '../../components/Actions';
import { ApprovalDetails } from '../../components/ApprovalDetails';
import { AffectedCisPanel } from '../../components/AffectedCis';
import { AnalysesSection } from './components/Analyses';
import { CommentBox } from '../../components/CommentBox';
import { GuidePanel } from '../../components/Guide';
import { SimilarProblems } from './components/Similar';
import { Markdown } from '../../components/Markdown';
import { richPaste } from '../../components/RichPaste';
import { TransitionButtons } from '../../components/TransitionButtons';
import { RecordNotFound, VisibilityPanel } from '../../components/Visibility';
import { DevLinksPanel } from '../../components/DevLinks';
import { SummaryButton } from '../../components/Ai';
import { AttachmentsPanel } from '../../components/Attachments';
import { FormModal } from '../../components/Modal';
import { CLOSURE_LABEL, DECISION_LABEL, EFFECTIVENESS_LABEL, formatDate, formatDay, LEVEL_LABEL, LINK_LABEL, PRIORITY_LABEL, relativeTime, RISK_LABEL } from '../../format';
import { useApi, useRecord } from '../../hooks';
import { useLive } from '../../hooks/useLive';
import { Presence } from '../../components/Presence';
import { canEdit, isManager, useSession } from '../../session';
import { ActivityLine, HistoryPanel } from '../../components/History';
import { NEXT_STATUS, PROBLEM_STATUS, STATUS_PHASE, TRANSITION_LABEL } from '../../statuses';

const LIFECYCLE: Status[] = ['new', 'analysis', 'known_error', 'resolved', 'closed'];

export function ProblemPage() {
  const navigate = useNavigate();
  const { ref } = useParams();
  const { user, meta } = useSession();
  const { data: p, setData, error, reload, refresh, actionError, setActionError, run } = useRecord<ProblemDetail>(`/api/problems/${ref}`);
  const others = useLive([p && `problem:${p.id}`], refresh, { presence: true });
  const [transition, setTransition] = useState<Status | null>(null);

  if (error) return <RecordNotFound refId={ref ?? ''} error={error} onOpened={reload} />;
  if (!p) return null;

  const editable = canEdit(user) && p.status !== 'closed';
  /** Saves fields; `base` holds the values the edit started from, so concurrent changes are detected. */
  const save = async (fields: Record<string, unknown>, base?: Record<string, unknown>, resolvesConflicts = false) => {
    setActionError(null);
    try {
      setData(await api.patch<ProblemDetail>(`/api/problems/${p.ref}`, base ? { ...fields, base } : fields));
    } catch (err) {
      const conflict = asConflict(err);
      // Text sections resolve conflicts with the user; for other fields, show the message and reload the current state.
      if (!conflict || !resolvesConflicts) setActionError((err as Error).message);
      if (conflict && !resolvesConflicts) reload();
      throw err;
    }
  };

  const confirmFields = async (fields: string[]) => {
    await run(() => api.post<ProblemDetail>(`/api/problems/${p.ref}/confirm`, { fields }));
  };

  const allowed = [...meta.transitions[p.status]].sort((a, b) => Number(b === NEXT_STATUS[p.status]) - Number(a === NEXT_STATUS[p.status])).filter((to) => {
    if (!canEdit(user)) return false;
    if ((to === 'closed' || p.status === 'closed') && !isManager(user)) return false;
    return true;
  });

  return (
    <>
      <header className="problem-head">
        <div className="crumbs">
          <Link to="/problems">Problems</Link> / <span className="mono">{p.ref}</span>
          <Presence people={others} />
          <span className="crumb-actions no-print">
            <WatchButton problem={p} onChange={setData} />
            <Link to={`/problems/${p.ref}/print`}>Print / PDF</Link>
            <a href={`/api/problems/${p.ref}/export.md`}>Export Markdown</a>
            {user.role === 'admin' && <Link to={`/admin/audit?entity_type=problem&entity_ref=${p.ref}`}>Audit trail</Link>}
          </span>
        </div>
        <EditableTitle value={p.title} editable={editable} onSave={(title) => save({ title }, { title: p.title })} />
        <div className="badges">
          {(p as any).contains_personal_data && <PersonalDataBadge />}
          <StatusBadge kind="problem" status={p.status} />
          <PriorityBadge priority={p.priority} />
          {p.is_major && <MajorBadge />}
          <span className="muted">
            Logged by {p.created_by_name} {relativeTime(p.created_at)} · {p.detection === 'proactive' ? 'Proactive' : 'Reactive'}
          </span>
        </div>
        <ol className="lifecycle">
          {LIFECYCLE.map((s) => (
            <li key={s} className={s === p.status ? 'current' : LIFECYCLE.indexOf(s) < LIFECYCLE.indexOf(p.status) ? 'done' : ''}>
              <span className="step-name">{PROBLEM_STATUS[s]}</span>
              <span className="step-phase">{STATUS_PHASE[s]}</span>
            </li>
          ))}
        </ol>
        {allowed.length > 0 && (
          <TransitionButtons buttons={allowed.map((to) => ({
            label: LIFECYCLE.indexOf(to) < LIFECYCLE.indexOf(p.status) ? 'Reopen analysis' : TRANSITION_LABEL[to],
            tone: NEXT_STATUS[p.status] === to ? 'primary' : undefined,
            onClick: () => setTransition(to),
          }))} />
        )}
        {actionError && <div className="error">{actionError}</div>}
        {!!p.from_reviews?.length && (
          <p className="muted small from-review">From the post-incident review of {p.from_reviews.map((r, n) => <span key={r.incident_ref}>{n ? ', ' : ''}<Link to={`/incidents/${r.incident_ref}/review`} className="mono">{r.incident_ref}</Link> {r.incident_title}</span>)}</p>
        )}
        {p.pending_approvals?.map((a) => (
          <div key={a.id} className="approval">
            <div>
              <strong>Waiting for approval:</strong> {a.summary}
              <div className="muted small">
                Requested by {a.requested_by}'s AI agent via {a.requested_via.toUpperCase()} {relativeTime(a.created_at)}
                {a.human_confirmation && <> · the agent reported: “{a.human_confirmation}”</>}
              </div>
              <ApprovalDetails payload={a.payload} changedSince={a.changed_since_request} />
            </div>
            <div className="approval-actions">
              <button className="btn small" onClick={async () => { try { setData(await api.post<ProblemDetail>(`/api/approvals/${a.id}/reject`, {})); } catch (err) { setActionError((err as Error).message); } }}>Reject</button>
              <button className="btn small primary" onClick={async () => { try { await api.post(`/api/approvals/${a.id}/approve`, {}); reload(); } catch (err) { setActionError((err as Error).message); } }}>Approve</button>
            </div>
          </div>
        ))}
      </header>

      <div className="problem-grid">
        <div className="problem-main">
          <GuidePanel guidance={p.next_steps} onHandover={async (h) => {
            if (h.action === 'raise_change') {
              const c = await api.post<{ ref: string }>(`/api/problems/${p.ref}/change`, {}).catch((err) => { alert((err as Error).message); return null; });
              if (c) navigate(`/changes/${c.ref}`);
            }
          }} />
          <TextSection recordRef={p.ref} title="Description" hint="Symptoms, scope and business impact" value={p.description} editable={editable} onSave={(v, b) => save({ description: v }, { description: b }, true)} proposed={p.mcp_proposed?.includes('description')} onConfirm={() => confirmFields(['description'])} />
          {(p.status !== 'new' || p.analyses.length > 0) && <AnalysesSection problem={p} onChange={setData} />}
          <TextSection recordRef={p.ref} title="Root cause" hint="Findings from problem analysis" value={p.root_cause} editable={editable} onSave={(v, b) => save({ root_cause: v }, { root_cause: b }, true)} proposed={p.mcp_proposed?.includes('root_cause')} onConfirm={() => confirmFields(['root_cause'])} />
          <TextSection recordRef={p.ref} title="Workaround" hint="How to reduce or eliminate the impact until resolved" value={p.workaround} editable={editable} onSave={(v, b) => save({ workaround: v }, { workaround: b }, true)} proposed={p.mcp_proposed?.includes('workaround')} onConfirm={() => confirmFields(['workaround'])} />
          {meta.modules?.knowledge !== false && (p.status === 'known_error' || p.knowledge_article) && (
            <section className="card kb-publish">
              {p.knowledge_article
                ? <span>Published as knowledge article <Link to={`/knowledge/${p.knowledge_article.ref}`} className="mono">{p.knowledge_article.ref}</Link> <span className="muted small">({p.knowledge_article.status}; it follows this problem)</span></span>
                : <>
                    <span>Share the workaround: publish this known error as a knowledge article. It follows the problem and is retired when it is resolved.</span>
                    {canEdit(user) && <button className="btn" onClick={async () => { try { const a = await api.post<{ ref: string }>(`/api/problems/${p.ref}/article`, {}); setData({ ...p, knowledge_article: { ref: a.ref, status: 'published' } }); } catch (err) { alert((err as Error).message); } }}>Publish as article</button>}
                  </>}
            </section>
          )}
          {(p.known_error_at || p.status === 'known_error') && <ErrorControlSection problem={p} onChange={setData} />}
          <TextSection recordRef={p.ref} title="Resolution" hint="The permanent solution, usually implemented through a change" value={p.resolution} editable={editable} onSave={(v, b) => save({ resolution: v }, { resolution: b }, true)} proposed={p.mcp_proposed?.includes('resolution')} onConfirm={() => confirmFields(['resolution'])} />
          {p.is_major && (
            <TextSection recordRef={p.ref} title="Major problem review" hint="What went well, what could be improved, how to prevent recurrence, follow-up actions"
              value={p.major_review} editable={editable} onSave={(v, b) => save({ major_review: v }, { major_review: b }, true)}  proposed={p.mcp_proposed?.includes('major_review')} onConfirm={() => confirmFields(['major_review'])} />
          )}
          <ActionsSection problem={p} onChange={setData} />
          <ActivitySection problem={p} onChange={setData} />
        </div>
        <aside className="problem-side">
          <DetailsPanel problem={p} editable={editable} onSave={save} />
          <SummaryButton recordRef={p.ref} onAddNote={async (body) => { await api.post(`/api/problems/${p.ref}/comments`, { body }); reload(); }} />
          <VisibilityPanel record={p as any} onChange={reload} />
          <DevLinksPanel recordRef={p.ref} editable={editable} />
          <AttachmentsPanel recordRef={p.ref} editable={editable} canDelete={(a) => a.uploaded_by === user.id || user.role === 'admin' || user.role === 'manager'} />
          <HistoryPanel recordRef={p.ref} version={p} />
          {meta.modules?.cmdb !== false && <AffectedCisPanel record={p} basePath={`/api/problems/${p.ref}`} editable={canEdit(user)} onChange={setData} />}
          {meta.modules?.change !== false && <ProblemChanges problem={p} editable={canEdit(user) && !['resolved', 'closed'].includes(p.status)} />}
          <ProblemImprovements problem={p} editable={canEdit(user)} />
          {meta.modules?.incident !== false && <ProblemIncidents problem={p} editable={canEdit(user)} onChange={setData} />}
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

function WatchButton({ problem: p, onChange }: { problem: ProblemDetail; onChange: (p: ProblemDetail) => void }) {
  const { user } = useSession();
  const watching = p.watchers.some((w) => w.id === user.id);
  const others = p.watchers.filter((w) => w.id !== user.id).map((w) => w.display_name);
  const toggle = async () => onChange(await (watching ? api.del<ProblemDetail>(`/api/problems/${p.ref}/watch`) : api.put<ProblemDetail>(`/api/problems/${p.ref}/watch`, {})));
  return (
    <button className={`btn-link watch ${watching ? 'on' : ''}`} onClick={toggle} title={p.watchers.length ? `Watching: ${p.watchers.map((w) => w.display_name).join(', ')}` : 'Nobody is watching'}>
      {watching ? '★ Watching' : '☆ Watch'}{others.length > 0 && <span className="muted"> · {others.length + (watching ? 1 : 0)}</span>}
    </button>
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

function TextSection(props: { recordRef: string; title: string; hint: string; value: string; editable: boolean; onSave: (v: string, base: string) => Promise<void>; proposed?: boolean; onConfirm?: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const start = () => {
    setBase(props.value);
    setDraft(props.value);
    setConflict(null);
  };
  const commit = async (against = base) => {
    setBusy(true);
    try {
      await props.onSave(draft ?? '', against);
      setDraft(null);
      setConflict(null);
    } catch (err) {
      setConflict(asConflict(err));
    } finally {
      setBusy(false);
    }
  };
  const theirs = conflict?.conflicts?.[0]?.current as string | undefined;
  return (
    <section className="card text-section">
      <div className="section-head">
        <h2>{props.title} {props.proposed && <span className="badge proposed-badge" title="Written by an AI agent through MCP; not yet confirmed by a person">Proposed via MCP</span>}</h2>
        <span className="section-actions">
          {props.proposed && props.editable && props.onConfirm && draft === null && <button className="btn-link" onClick={props.onConfirm}>Confirm</button>}
          {props.editable && draft === null && <button className="btn-link" onClick={start}>Edit</button>}
        </span>
      </div>
      {draft !== null ? (
        <>
          {conflict && (
            <div className="conflict">
              <strong>{conflict.changed_by ?? 'Someone'} changed this{conflict.changed_at ? ` ${relativeTime(conflict.changed_at)}` : ''} while you were editing.</strong>
              <div className="conflict-theirs">
                <span className="muted small">Their version</span>
                {theirs ? <Markdown text={theirs} /> : <p className="muted">(empty)</p>}
              </div>
              <div className="actions">
                <button className="btn" onClick={() => { setDraft(null); setConflict(null); }}>Discard mine, keep theirs</button>
                <button className="btn" onClick={() => setDraft(`${theirs ?? ''}\n\n${draft}`)}>Combine both</button>
                <button className="btn danger" onClick={() => { setBase(theirs ?? ''); commit(theirs ?? ''); }}>Overwrite with mine</button>
              </div>
            </div>
          )}
          <textarea autoFocus rows={Math.max(5, draft.split('\n').length + 1)} value={draft} placeholder={props.hint} onChange={(e) => setDraft(e.target.value)} {...richPaste(props.recordRef, setDraft, setPasteError)} />
          {pasteError && <div className="error small">{pasteError}</div>}
          <span className="muted small">Markdown supported. Paste a screenshot or formatted text; Ctrl+Shift+V pastes plain text.</span>
          <div className="actions">
            <button className="btn" onClick={() => setDraft(null)} disabled={busy}>Cancel</button>
            <button className="btn primary" onClick={() => commit()} disabled={busy || !!conflict}>Save</button>
          </div>
        </>
      ) : props.value ? (
        <Markdown text={props.value} />
      ) : (
        <p className="placeholder">{props.hint}</p>
      )}
    </section>
  );
}

function DetailsPanel({ problem: p, editable, onSave }: { problem: ProblemDetail; editable: boolean; onSave: (f: Record<string, unknown>, base?: Record<string, unknown>) => Promise<void> }) {
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
      <select value={value ?? ''} onChange={(e) => onSave({ [key]: e.target.value === '' ? null : typeof value === 'number' || key.endsWith('_id') || key === 'impact' || key === 'urgency' ? Number(e.target.value) : e.target.value }, { [key]: value }).catch(() => {})}>
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
            onBlur={() => { if (service !== null && service !== p.affected_service) onSave({ affected_service: service }, { affected_service: p.affected_service }).catch(() => {}); setService(null); }} />
        ) : p.affected_service || '–')}
        {field('Detection', select('detection', p.detection, [['reactive', 'Reactive (incidents)'], ['proactive', 'Proactive (events, trends)']]))}
        {field('Impact', select('impact', p.impact, [1, 2, 3].map((l) => [l, `${l} – ${LEVEL_LABEL[l]}`])))}
        {field('Urgency', select('urgency', p.urgency, [1, 2, 3].map((l) => [l, `${l} – ${LEVEL_LABEL[l]}`])))}
        {field('Priority', <strong>P{p.priority} {PRIORITY_LABEL[p.priority]}</strong>)}
        {field('Major problem', editable && isManager(user) ? (
          <label className="check"><input type="checkbox" checked={p.is_major} onChange={(e) => onSave({ is_major: e.target.checked }, { is_major: p.is_major }).catch(() => {})} /> {p.is_major ? 'Yes' : 'No'}</label>
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
  const proposedEc = (p.mcp_proposed ?? []).filter((f) => f.startsWith('ec_'));
  const confirmEc = async () => onChange(await api.post<ProblemDetail>(`/api/problems/${p.ref}/confirm`, { fields: proposedEc }));
  return (
    <section className="card error-control">
      <div className="section-head">
        <h2>Error control {proposedEc.length > 0 && <span className="badge proposed-badge">Proposed via MCP</span>}</h2>
        <span className="section-actions">
          {proposedEc.length > 0 && editable && <button className="btn-link" onClick={confirmEc}>Confirm</button>}
          {editable && <button className="btn-link" onClick={() => setEditing(true)}>{empty ? 'Assess' : 'Edit'}</button>}
        </span>
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
          {p.ec_risk && (<><dt>Risk of not fixing</dt><dd><Markdown text={p.ec_risk} /></dd></>)}
          {p.ec_fix_cost && (<><dt>Cost of fixing</dt><dd><Markdown text={p.ec_fix_cost} /></dd></>)}
          {p.ec_decision_note && (<><dt>Rationale</dt><dd><Markdown text={p.ec_decision_note} /></dd></>)}
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
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = async () => {
    onDone(await api.put<ProblemDetail>(`/api/problems/${p.ref}/assessment`, {
      ...form,
      ec_risk_level: form.ec_risk_level ? Number(form.ec_risk_level) : null,
      ec_decision: form.ec_decision || null,
      ec_review_date: form.ec_review_date || null,
      workaround_effectiveness: form.workaround_effectiveness || null,
    }));
  };
  const managerOnly = (d: string) => (d === 'accept' || d === 'defer') && !isManager(user);
  return (
    <FormModal title={`Error control – ${p.ref}`} submitLabel="Save assessment" onClose={onClose} onSubmit={submit}>
      <p className="hint full">Weigh the risk of living with this known error against the cost of a permanent fix. Accepting or deferring the risk is a decision for a manager.</p>
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
          {meta.ec_decisions.map((d) => <option key={d} value={d} disabled={managerOnly(d)}>{DECISION_LABEL[d]}{managerOnly(d) ? ' (managers)' : ''}</option>)}
        </select>
      </label>
      <label>Review date
        <input type="date" value={form.ec_review_date} onChange={set('ec_review_date')} />
      </label>
      <label className="full">Rationale
        <textarea rows={3} value={form.ec_decision_note} onChange={set('ec_decision_note')} />
      </label>
    </FormModal>
  );
}

function ActionsSection({ problem: p, onChange }: { problem: ProblemDetail; onChange: (p: ProblemDetail) => void }) {
  const { user } = useSession();
  return (
    <ActionsCard parent={p.ref} actions={p.actions} editable={canEdit(user)} onChanged={() => api.get<ProblemDetail>(`/api/problems/${p.ref}`).then(onChange)}
      placeholder="No follow-up actions. Add actions for fixes, vendor follow-ups, monitoring or review outcomes." />
  );
}

function ActivitySection({ problem: p, onChange }: { problem: ProblemDetail; onChange: (p: ProblemDetail) => void }) {
  const { user } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'comments'>('all');

  const submit = async (body: string) => {
    setError(null);
    try {
      onChange(await api.post<ProblemDetail>(`/api/problems/${p.ref}/comments`, { body }));
    } catch (err) {
      setError((err as Error).message);
      return false;
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
        <CommentBox recordRef={p.ref} rows={3} placeholder="Add a work note: findings, analysis steps, decisions… Paste screenshots and logs here." error={error} onError={setError} onSubmit={submit} />
      )}
      <ul className="activity">
        {items.map((a) => <li key={a.id}><ActivityLine activity={a} /></li>)}
      </ul>
    </section>
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
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const reopen = LIFECYCLE.indexOf(to) < LIFECYCLE.indexOf(p.status);

  const submit = async () => {
    const body: Record<string, unknown> = { to, comment: form.comment || undefined };
    if (to === 'known_error') Object.assign(body, { root_cause: form.root_cause, workaround: form.workaround });
    if (to === 'resolved') Object.assign(body, { resolution: form.resolution });
    if (to === 'closed') {
      Object.assign(body, { closure_code: form.closure_code || undefined, acknowledge_open_actions: acknowledge || undefined });
      if (p.is_major) body.major_review = form.major_review;
    }
    onDone(await api.post<ProblemDetail>(`/api/problems/${p.ref}/transition`, body));
  };

  const title = reopen ? 'Reopen analysis' : TRANSITION_LABEL[to];
  return (
    <FormModal title={`${title} – ${p.ref}`} submitLabel={title} onClose={onClose} onSubmit={submit}>
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
    </FormModal>
  );
}

/** Native incidents linked to the problem; once it is resolved, their open incidents can be resolved in one go. */
function ProblemIncidents({ problem: p, editable, onChange }: { problem: ProblemDetail; editable: boolean; onChange: (p: ProblemDetail) => void }) {
  const open = p.incidents.filter((i) => !['resolved', 'closed'].includes(i.status));
  const [error, setError] = useState<string | null>(null);
  if (!p.incidents.length) return null;
  const resolveAll = async () => {
    const resolution = window.prompt(`Resolve ${open.length} open incident(s) with this problem's resolution?`, p.resolution || `Resolved by problem ${p.ref}.`);
    if (!resolution?.trim()) return;
    try {
      const result = await api.post<ProblemDetail & { resolve_result: { resolved: string[]; failed: { ref: string; error: string }[] } }>(`/api/problems/${p.ref}/resolve-incidents`, { incidents: open.map((i) => i.ref), resolution });
      onChange(result);
      if (result.resolve_result.failed.length) setError(`Not resolved: ${result.resolve_result.failed.map((f) => `${f.ref} (${f.error})`).join('; ')}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Incidents <span className="count">{open.length ? `${open.length} open` : p.incidents.length}</span></h2>
      <ul className="plain-list">
        {p.incidents.map((i) => (
          <li key={i.ref}>
            <Link to={`/incidents/${i.ref}`} className="mono">{i.ref}</Link> {i.title} <span className="muted small">{i.status.replace('_', ' ')}</span>
          </li>
        ))}
      </ul>
      {editable && open.length > 0 && ['resolved', 'closed'].includes(p.status) && (
        <div className="hint-box hint-row">
          The problem is resolved: {open.length} linked incident{open.length > 1 ? 's are' : ' is'} still open.
          <button className="btn small" onClick={resolveAll}>Resolve them</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}

/** Changes raised for the problem's fix; "Raise change" prefills one from the known error. */
/** Lessons learned → improvement (#52): optional, once the problem is resolved or closed. */
function ProblemImprovements({ problem: p, editable }: { problem: ProblemDetail; editable: boolean }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const done = ['resolved', 'closed'].includes(p.status);
  const list = p.improvements ?? [];
  if (!list.length && !(editable && done)) return null;
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const m = await api.post<{ ref: string }>(`/api/problems/${p.ref}/improvement`, { title });
      navigate(`/improvements/${m.ref}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Improvements</h2>
      <ul className="plain-list">
        {list.map((m) => <li key={m.ref}><Link to={`/improvements/${m.ref}`} className="mono">{m.ref}</Link> {m.title} <span className="muted small">{m.status.replace('_', ' ')}</span></li>)}
      </ul>
      {editable && done && (
        <form className="rel-form small" onSubmit={create}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Lessons learned: what should change?" aria-label="Improvement title" />
          <button className="btn small" disabled={!title.trim()}>Suggest an improvement</button>
        </form>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}

function ProblemChanges({ problem: p, editable }: { problem: ProblemDetail; editable: boolean }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  if (!p.changes.length && !(editable && ['known_error', 'analysis'].includes(p.status))) return null;
  const raise = async () => {
    try {
      const c = await api.post<{ ref: string }>(`/api/problems/${p.ref}/change`, {});
      navigate(`/changes/${c.ref}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card">
      <div className="section-head"><h2>Changes</h2>{editable && <button className="btn-link" onClick={raise}>+ Raise change for fix</button>}</div>
      {p.changes.length === 0 && <p className="placeholder">The permanent fix is usually implemented through a change.</p>}
      <ul className="plain-list">
        {p.changes.map((c) => (
          <li key={c.ref}><Link to={`/changes/${c.ref}`} className="mono">{c.ref}</Link> {c.title} <span className="muted small">{c.status}{c.outcome ? `, ${c.outcome.replace('_', ' ')}` : ''}</span></li>
        ))}
      </ul>
      {error && <div className="error">{error}</div>}
    </section>
  );
}
