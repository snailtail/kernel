// The post-incident review (#109): a short, blameless look back that starts filled in, follows a guided template, and
// turns contributing factors into problems and follow-ups into actions.
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api';
import { useAiStatus } from '../components/Ai';
import { Markdown } from '../components/Markdown';
import { formatDate } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { HistoryPanel } from '../components/History';

type Section = 'what_happened' | 'impact_summary' | 'went_well' | 'was_hard' | 'lucky';
interface Item {
  id: number; kind: 'factor' | 'follow_up' | 'gap'; body: string; created_by: string | null; problem_ref: string | null; problem_title: string | null;
  problem_status: string | null;
  action_id: number | null; action_title: string | null; action_status: string | null; action_due: string | null; action_owner: string | null; action_problem_ref: string | null;
  improvement_ref: string | null; improvement_title: string | null; improvement_status: string | null;
}
interface Review {
  ref: string; incident_ref: string; incident_title: string; is_major: boolean; status: 'scheduled' | 'draft' | 'published' | 'waived'; owner_id: number | null; owner: string | null;
  due: string | null; due_in_days: number | null; overdue: boolean; attendees: string; waived_reason: string; published_at: string | null; published_by: string | null;
  items: Item[]; comments: { id: number; body: string; created_at: string; created_by: string | null }[]; may_finish: boolean; confidential_masked?: boolean;
  context: { timeline: { at: string; label: string; body: string; key_moment: boolean }[]; impact: string; problem_ref: string | null };
  guide: { purpose: string; wording: string; sections: Record<Section, string> };
}
type ReviewData = Review & Record<Section, string>;

const SECTIONS: [Section, string][] = [['what_happened', 'What happened'], ['impact_summary', 'Impact'], ['went_well', 'What went well'], ['was_hard', 'What was hard'], ['lucky', 'Where we were lucky']];
const KINDS: [Item['kind'], string, string][] = [
  ['factor', 'Contributing factors', 'Conditions that made the incident possible. Each can become a problem, where root cause analysis continues.'],
  ['follow_up', 'Follow-up', 'Concrete actions with an owner and a date. Each becomes an action on a problem, or an improvement for a change to how things work.'],
  ['gap', 'Detection and response gaps', 'What made it slow to notice or to respond: alerting, runbooks, access, people.'],
];
const STATUS_LABEL: Record<Review['status'], string> = { scheduled: 'Scheduled', draft: 'Draft', published: 'Published', waived: 'Waived' };

export function IncidentReviewPage() {
  const { ref } = useParams();
  const { user, meta } = useSession();
  const ai = useAiStatus();
  const { data: r, setData, error } = useApi<ReviewData>(`/api/reviews/${ref}`);
  const [draft, setDraft] = useState<Partial<Record<Section | 'attendees', string>>>({});
  const [newItem, setNewItem] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [hint, setHint] = useState<{ text: string; model: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  if (error) return <p className="error">{error}</p>;
  if (!r) return null;
  const path = `/api/incidents/${r.incident_ref}/review`;
  const editable = user.role !== 'viewer' && (r.status === 'scheduled' || r.status === 'draft');
  const manager = user.role === 'admin' || user.role === 'manager';
  const dirty = Object.keys(draft).length > 0;
  const run = async (fn: () => Promise<ReviewData>) => {
    setActionError(null);
    try { setData(await fn()); return true; } catch (err) { setActionError((err as Error).message); return false; }
  };
  const save = () => run(() => api.patch(path, draft)).then((ok) => ok && setDraft({}));
  const people = meta.assignees.filter((a) => a.role !== 'viewer');

  return (
    <>
      <header className="problem-head">
        <div className="crumbs"><Link to="/incidents">Incidents</Link> / <Link to={`/incidents/${r.incident_ref}`} className="mono">{r.incident_ref}</Link> / Review <span className="mono">{r.ref}</span></div>
        <h1>Post-incident review: {r.incident_title}</h1>
        <div className="badges">
          <span className={`badge review-${r.status}`}>{STATUS_LABEL[r.status]}</span>
          {r.overdue && <span className="badge overdue">Overdue</span>}
          <span className="muted small">
            {r.owner ? `Owner ${r.owner}` : 'No owner'}
            {r.due && r.status !== 'published' && r.status !== 'waived' ? ` · due ${r.due}${r.due_in_days !== null && r.due_in_days >= 0 ? ` (in ${r.due_in_days} day${r.due_in_days === 1 ? '' : 's'})` : ''}` : ''}
            {r.published_at ? ` · published ${formatDate(r.published_at)}${r.published_by ? ` by ${r.published_by}` : ''}` : ''}
          </span>
        </div>
        <div className="transitions no-print">
          {editable && r.may_finish && <button className="btn primary" disabled={dirty} title={dirty ? 'Save your changes first' : ''} onClick={() => window.confirm('Publish the review? It becomes read-only.') && run(() => api.post(`${path}/publish`, {}))}>Publish</button>}
          {editable && manager && <button className="btn" onClick={() => { const reason = window.prompt('Why does this incident need no review?'); if (reason?.trim()) run(() => api.post(`${path}/waive`, { reason: reason.trim() })); }}>Waive</button>}
          <a className="btn" href={`${path}/export.md`} download>Markdown</a>
          <button className="btn" onClick={() => window.print()}>Print</button>
          {user.role !== 'viewer' && meta.modules?.knowledge !== false && <button className="btn" onClick={async () => { setActionError(null); try { const a = await api.post<{ ref: string }>(`${path}/article`, {}); window.location.assign(`/knowledge/${a.ref}`); } catch (err) { setActionError((err as Error).message); } }}>Draft an article</button>}
        </div>
        {actionError && <div className="error">{actionError}</div>}
        {r.status === 'waived' && <p className="warn-box">Waived: {r.waived_reason}</p>}
      </header>

      <div className="problem-grid">
        <div className="problem-main">
          {editable && (
            <section className="card hint-card no-print">
              <h2>Blameless</h2>
              <p className="small">{r.guide.purpose}</p>
              <p className="small muted">{r.guide.wording}</p>
              {ai.review_wording && (
                <>
                  <button className="btn small" disabled={busy} onClick={async () => {
                    setBusy(true); setActionError(null);
                    try { setHint(await api.post('/api/ai/review-wording', { ref: r.incident_ref })); } catch (err) { setActionError((err as Error).message); } finally { setBusy(false); }
                  }}>{busy ? 'Checking…' : '✨ Check the wording with AI'}</button>
                  {hint && <div className="ai-output"><p className="muted small">AI hint ({hint.model}): only a suggestion, nothing was changed.</p><Markdown text={hint.text} /></div>}
                </>
              )}
            </section>
          )}
          <section className="card">
            <h2>Review</h2>
            {editable ? (
              <form className="form pir-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
                <label className="full">Attendees<input value={draft.attendees ?? r.attendees} placeholder="Who took part" onChange={(e) => setDraft({ ...draft, attendees: e.target.value })} /></label>
                {SECTIONS.map(([k, label]) => (
                  <label key={k} className="full">{label} <span className="muted small">{r.guide.sections[k]}</span>
                    <textarea rows={k === 'what_happened' || k === 'impact_summary' ? 8 : 4} value={draft[k] ?? r[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                  </label>
                ))}
                <div className="actions full"><button className="btn primary" disabled={!dirty}>Save</button>{dirty && <button type="button" className="btn" onClick={() => setDraft({})}>Discard</button>}</div>
              </form>
            ) : (
              <>
                {r.attendees && <p className="muted small">Attendees: {r.attendees}</p>}
                {SECTIONS.map(([k, label]) => <div key={k}><h3>{label}</h3>{r[k] ? <Markdown text={r[k]} /> : <p className="placeholder">–</p>}</div>)}
              </>
            )}
          </section>
          {KINDS.map(([kind, title, hintText]) => {
            const list = r.items.filter((x) => x.kind === kind);
            return (
              <section key={kind} className="card">
                <h2>{title} {list.length > 0 && <span className="count">{list.length}</span>}</h2>
                <p className="muted small">{hintText}</p>
                <ul className="plain-list pir-items">
                  {list.map((x) => (
                    <li key={x.id}>
                      <div>{x.body}</div>
                      <ItemOutput item={x} reviewPath={path} editable={user.role !== 'viewer'} defaultProblem={r.items.find((f) => f.kind === 'factor' && f.problem_ref)?.problem_ref ?? r.context.problem_ref} people={people} onChange={run} />
                      {editable && !x.problem_ref && !x.action_id && <button className="btn-link small no-print" onClick={() => run(() => api.del(`${path}/items/${x.id}`))}>Remove</button>}
                    </li>
                  ))}
                </ul>
                {editable && (
                  <form className="rel-form no-print" onSubmit={(e) => { e.preventDefault(); const body = (newItem[kind] ?? '').trim(); if (body) run(() => api.post(`${path}/items`, { kind, body })).then((ok) => ok && setNewItem({ ...newItem, [kind]: '' })); }}>
                    <input value={newItem[kind] ?? ''} onChange={(e) => setNewItem({ ...newItem, [kind]: e.target.value })} placeholder={kind === 'factor' ? 'e.g. Certificate expiry is not monitored' : kind === 'follow_up' ? 'e.g. Alert 30 days before a certificate expires' : 'e.g. No alert on payment errors'} aria-label={`New ${title.toLowerCase()}`} />
                    <button className="btn" disabled={!(newItem[kind] ?? '').trim()}>Add</button>
                  </form>
                )}
              </section>
            );
          })}
        </div>
        <aside className="problem-side">
          <section className="card">
            <h2>Impact from Kernel</h2>
            <Markdown text={r.context.impact || '–'} />
          </section>
          <section className="card">
            <h2>Timeline</h2>
            <ol className="timeline compact">
              {r.context.timeline.map((e, n) => (
                <li key={n}><time>{formatDate(e.at)}</time><div><strong>{e.label}</strong>{e.key_moment && ' ★'}</div></li>
              ))}
            </ol>
            <Link to={`/incidents/${r.incident_ref}`} className="small">The incident</Link>
          </section>
          <section className="card">
            <h2>Notes <span className="count">{r.comments.length}</span></h2>
            {r.comments.length > 0 && (
              <ul className="activity compact">
                {r.comments.map((c) => <li key={c.id}><div className="muted small">{c.created_by ?? 'Someone'} · {formatDate(c.created_at)}</div><Markdown text={c.body} /></li>)}
              </ul>
            )}
            {user.role !== 'viewer' && (
              <form className="no-print" onSubmit={(e) => { e.preventDefault(); if (note.trim()) void run(() => api.post(`/api/reviews/${r.ref}/comments`, { body: note.trim() })).then((ok) => ok && setNote('')); }}>
                <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note for the people on the review" aria-label="Note" />
                <button className="btn small" disabled={!note.trim()}>Add note</button>
              </form>
            )}
          </section>
          <HistoryPanel recordRef={r.ref} version={r} />
        </aside>
      </div>
    </>
  );
}

/** Where an item went: a problem, an action, an improvement, or the buttons to get it there. */
function ItemOutput({ item: x, reviewPath, editable, defaultProblem, people, onChange }: {
  item: Item; reviewPath: string; editable: boolean; defaultProblem: string | null; people: { id: number; display_name: string }[];
  onChange: (fn: () => Promise<any>) => Promise<boolean>;
}) {
  const [problem, setProblem] = useState('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState('');
  if (x.problem_ref) return <div className="small">→ <Link to={`/problems/${x.problem_ref}`} className="mono">{x.problem_ref}</Link> {x.problem_title} <span className="muted">{x.problem_status?.replace('_', ' ')}</span></div>;
  if (x.action_id) return <div className="small">→ action on <Link to={`/problems/${x.action_problem_ref}`} className="mono">{x.action_problem_ref}</Link>{x.action_owner ? `, ${x.action_owner}` : ''}{x.action_due ? `, due ${x.action_due}` : ''} <span className="muted">{x.action_status}</span></div>;
  if (x.improvement_ref) return <div className="small">→ improvement <Link to={`/improvements/${x.improvement_ref}`} className="mono">{x.improvement_ref}</Link> {x.improvement_title} <span className="muted">{x.improvement_status?.replace('_', ' ')}</span></div>;
  if (!editable) return null;
  if (x.kind === 'factor') {
    return (
      <div className="rel-form small no-print">
        <button className="btn small" onClick={() => onChange(() => api.post(`${reviewPath}/items/${x.id}/problem`, {}))}>Create a problem</button>
        <span className="muted">or link</span>
        <input value={problem} onChange={(e) => setProblem(e.target.value)} placeholder="PRB…" aria-label="Existing problem" />
        <button className="btn small" disabled={!problem.trim()} onClick={() => onChange(() => api.post(`${reviewPath}/items/${x.id}/problem`, { problem: problem.trim() }))}>Link</button>
      </div>
    );
  }
  return (
    <div className="rel-form small no-print">
      <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Action owner"><option value="">Owner…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select>
      <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
      <input value={problem} onChange={(e) => setProblem(e.target.value)} placeholder={defaultProblem ?? 'PRB…'} aria-label="On problem" />
      <button className="btn small" disabled={!problem.trim() && !defaultProblem} title={!problem.trim() && !defaultProblem ? 'Actions live on a problem: turn a contributing factor into one first' : ''}
        onClick={() => onChange(() => api.post(`${reviewPath}/items/${x.id}/action`, { ...(owner ? { owner_id: Number(owner) } : {}), ...(due ? { due_date: due } : {}), ...(problem.trim() ? { problem: problem.trim() } : {}) }))}>Create action</button>
      <span className="muted">or</span>
      <button className="btn small" title="For a change to how things work rather than a fix: it goes to the continual improvement register"
        onClick={() => onChange(() => api.post(`${reviewPath}/items/${x.id}/improvement`, { ...(owner ? { owner_id: Number(owner) } : {}) }))}>Suggest an improvement</button>
    </div>
  );
}
