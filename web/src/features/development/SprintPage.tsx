// Development work (#166): one sprint from planning to the retrospective: its goal, points against capacity, the items
// (planning while it is planned or active), the burndown, the team's velocity, the sprint review and the retrospective.
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../../api/client';
import { StatusBadge } from '../../components/Badges';
import { TransitionButtons } from '../../components/TransitionButtons';
import { formatDay } from '../../format';
import { useRecord } from '../../hooks';
import { useLive } from '../../hooks/useLive';
import { canEdit, useSession } from '../../session';
import type { Sprint } from '../../api/types/development';
import { TypeBadge } from './common';
import { Retrospective } from './components/Retrospective';
import { Burndown, Velocity } from './components/SprintCharts';
import { CompleteSprint, SprintForm, SprintStatusTag } from './components/SprintForms';
import { SprintPlanning } from './components/SprintPlanning';
import './styles.css';

const OUTCOME: Record<string, string> = { done: 'Done', backlog: 'Back to the backlog', next_sprint: 'On to the next sprint' };

export function SprintPage() {
  const { id } = useParams();
  const { user } = useSession();
  const { data: s, error, reload, refresh, actionError, run } = useRecord<Sprint>(`/api/sprints/${id}`);
  useLive(['work_item:*'], refresh);
  const [editing, setEditing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);
  if (error) return <div className="error">{error}</div>;
  if (!s) return null;
  const editable = canEdit(user);
  const p = s.points;
  return (
    <>
      <header className="problem-head">
        <div className="crumbs"><Link to={`/sprints?team=${s.team_id}`}>{s.team} sprints</Link> / <span>{s.name}</span></div>
        <h1>{s.name}</h1>
        <div className="badges">
          <SprintStatusTag status={s.status} />
          <span className="muted small">{formatDay(s.starts_on)} – {formatDay(s.ends_on)}</span>
          {s.status === 'active' && <Link to={`/board?team=${s.team_id}`} className="tag">Open the board</Link>}
        </div>
        {editable && (
          <TransitionButtons buttons={[
            ...(s.status === 'planned' ? [{ label: 'Start the sprint', tone: 'primary' as const, onClick: () => run(() => api.post<Sprint>(`/api/sprints/${s.id}/start`, {})) }] : []),
            ...(s.status === 'active' ? [{ label: 'Complete the sprint', tone: 'primary' as const, onClick: () => setCompleting(true) }] : []),
            { label: 'Edit', onClick: () => setEditing(true) },
          ]} />
        )}
        {actionError && <div className="error">{actionError}</div>}
      </header>

      <p className="sp-guide"><strong>{s.next_steps.phase}.</strong> {s.next_steps.purpose} <span className="muted">Next: {s.next_steps.next}.</span></p>
      <section className="card sp-goal"><h2>Sprint goal</h2>{s.goal ? <p>{s.goal}</p> : <p className="placeholder">No goal yet.{editable ? ' One sentence the team can rally around.' : ''}</p>}</section>

      <div className="sp-stats">
        <div className="card sp-stat"><span className="muted small">Points in the sprint</span><strong className={s.over_capacity ? 'warn' : ''}>{p.scope}{s.capacity ? ` / ${s.capacity}` : ''}</strong></div>
        <div className="card sp-stat"><span className="muted small">Done</span><strong>{p.completed}</strong><span className="muted small">{s.items.done} of {s.items.total} items</span></div>
        <div className="card sp-stat"><span className="muted small">Committed at the start</span><strong>{p.committed ?? '–'}</strong></div>
        <div className="card sp-stat"><span className="muted small">Unplanned</span><strong>{p.unplanned_share === null ? '–' : `${p.unplanned_share} %`}</strong><span className="muted small">{p.unplanned} points added after the start</span></div>
      </div>

      {editable && s.status !== 'completed' ? <SprintPlanning sprint={s} onChanged={reload} /> : (
        <section className="card">
          <h2>Items <span className="count">{s.work_items.length}</span></h2>
          {s.work_items.length === 0 ? <p className="placeholder">Nothing planned.</p> : (
            <ul className="wi-backlog">
              {s.work_items.map((w) => (
                <li key={w.ref} className="wi-row">
                  <span className="wi-main"><TypeBadge type={w.item_type} /> <Link to={`/work/${w.ref}`} className="wi-title">{w.title}</Link>{w.unplanned && <span className="tag">unplanned</span>}</span>
                  <span className="wi-meta">
                    {w.outcome ? <span className="muted small">{OUTCOME[w.outcome]}</span> : <StatusBadge kind="work_item" status={w.status} />}
                    <span className="wi-points small">{w.points ?? '–'}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="sp-charts">
        <section className="card"><h2>Burndown</h2>{s.burndown ? <Burndown days={s.burndown} /> : <p className="placeholder">The burndown starts with the sprint.</p>}</section>
        <section className="card"><h2>Velocity</h2>{s.velocity.sprints.length ? <Velocity v={s.velocity} /> : <p className="placeholder">Shown once the team has completed a sprint.</p>}</section>
      </div>

      {s.status !== 'planned' && (
        <>
          <section className="card">
            <h2>Sprint review</h2>
            {notes === null ? (
              <>
                {s.review_notes ? <p className="prose">{s.review_notes}</p> : <p className="placeholder">What was shown, and what the stakeholders said.</p>}
                {editable && <div><button className="btn small" onClick={() => setNotes(s.review_notes)}>{s.review_notes ? 'Edit' : 'Write the review'}</button></div>}
              </>
            ) : (
              <form onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.patch<Sprint>(`/api/sprints/${s.id}`, { review_notes: notes }))) setNotes(null); }}>
                <textarea rows={4} className="sp-notes" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Sprint review notes" />
                <div className="actions"><button type="button" className="btn" onClick={() => setNotes(null)}>Cancel</button><button className="btn primary">Save</button></div>
              </form>
            )}
          </section>
          <Retrospective sprint={s} editable={editable} onChanged={reload} />
        </>
      )}

      {editing && <SprintForm sprint={s} onClose={() => setEditing(false)} onDone={() => { setEditing(false); reload(); }} />}
      {completing && <CompleteSprint sprint={s} onClose={() => setCompleting(false)} onDone={() => { setCompleting(false); reload(); }} />}
    </>
  );
}
