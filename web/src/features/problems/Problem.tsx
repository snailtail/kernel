import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, asConflict, type ProblemDetail, type Status } from '../../api/client';
import { MajorBadge, PersonalDataBadge, PriorityBadge, StatusBadge } from '../../components/Badges';
import { ApprovalDetails } from '../../components/ApprovalDetails';
import { AffectedCisPanel } from '../../components/AffectedCis';
import { AnalysesSection } from './components/Analyses';
import { GuidePanel } from '../../components/Guide';
import { SimilarProblems } from './components/Similar';
import { TransitionButtons } from '../../components/TransitionButtons';
import { RecordNotFound, VisibilityPanel } from '../../components/Visibility';
import { DevLinksPanel } from '../../components/DevLinks';
import { createWorkItemFrom, TraceCard } from '../../components/Trace';
import { SummaryButton } from '../../components/Ai';
import { AttachmentsPanel } from '../../components/Attachments';
import { relativeTime } from '../../format';
import { useRecord } from '../../hooks';
import { useLive } from '../../hooks/useLive';
import { Presence } from '../../components/Presence';
import { canEdit, isManager, useSession } from '../../session';
import { HistoryPanel } from '../../components/History';
import { NEXT_STATUS, PROBLEM_LIFECYCLE, PROBLEM_STATUS, STATUS_PHASE, TRANSITION_LABEL } from '../../statuses';
import { WatchButton } from './components/WatchButton';
import { EditableTitle } from './components/EditableTitle';
import { TextSection } from './components/TextSection';
import { DetailsPanel } from './components/DetailsPanel';
import { LinksPanel } from './components/LinksPanel';
import { ErrorControlSection } from './components/ErrorControlSection';
import { ActionsSection } from './components/ActionsSection';
import { ActivitySection } from './components/ActivitySection';
import { TransitionModal } from './components/TransitionModal';
import { ProblemIncidents, ProblemImprovements, ProblemChanges } from './components/RelatedRecords';
import './styles.css';

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
          {PROBLEM_LIFECYCLE.map((s) => (
            <li key={s} className={s === p.status ? 'current' : PROBLEM_LIFECYCLE.indexOf(s) < PROBLEM_LIFECYCLE.indexOf(p.status) ? 'done' : ''}>
              <span className="step-name">{PROBLEM_STATUS[s]}</span>
              <span className="step-phase">{STATUS_PHASE[s]}</span>
            </li>
          ))}
        </ol>
        {allowed.length > 0 && (
          <TransitionButtons buttons={allowed.map((to) => ({
            label: PROBLEM_LIFECYCLE.indexOf(to) < PROBLEM_LIFECYCLE.indexOf(p.status) ? 'Reopen analysis' : TRANSITION_LABEL[to],
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
            if (h.action === 'resolve_problem') setTransition('resolved');
            if (h.action === 'create_bug') {
              const w = await createWorkItemFrom(p.ref).catch((err) => { alert((err as Error).message); return null; });
              if (w) navigate(`/work/${w}`);
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
          <TraceCard recordRef={p.ref} version={p} />
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
