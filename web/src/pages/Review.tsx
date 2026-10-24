import { useState } from 'react';
import { HiddenRecordsNote } from '../components/Visibility';
import { Link } from 'react-router';
import { api } from '../api';
import { ActionList } from '../components/Actions';
import { MajorBadge, PriorityBadge, StatusBadge } from '../components/Badges';
import { formatDay, relativeTime } from '../format';
import { useApi } from '../hooks';
import { canEdit, useSession } from '../session';
import type { ReviewAgenda } from '../api/types/work';

export function ReviewPage() {
  const { user, meta } = useSession();
  const [staleDays, setStaleDays] = useState(14);
  const { data, reload } = useApi<ReviewAgenda>(`/api/review?stale_days=${staleDays}`);
  const [hideEmpty, setHideEmpty] = useState(true);
  const editable = canEdit(user);
  const total = data ? data.sections.reduce((n, s) => n + s.problems.length, 0) + data.overdue_actions.length : 0;

  const assign = async (ref: string, assignee_id: number) => {
    await api.patch(`/api/problems/${ref}`, { assignee_id });
    reload();
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Problem review board</h1>
          <p className="muted">Agenda for the problem review meeting: everything in the backlog that needs a decision or attention.</p>
        </div>
        <div className="head-actions no-print">
          <a className="btn" href={`/api/review/agenda.md?stale_days=${staleDays}`}>Export Markdown</a>
          <button className="btn" onClick={() => window.print()}>Print</button>
        </div>
      </header>
      <HiddenRecordsNote />
      <div className="filters no-print">
        <label className="check">
          Stale after
          <select value={staleDays} onChange={(e) => setStaleDays(Number(e.target.value))}>
            {[7, 14, 30, 60].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> Hide empty sections</label>
        {data && <span className="muted small">{total} item{total === 1 ? '' : 's'} · generated {relativeTime(data.generated_at)}</span>}
      </div>
      {data && total === 0 && <section className="card"><p className="empty">Nothing needs attention. The backlog is in good shape.</p></section>}
      {data?.sections.filter((s) => !hideEmpty || s.problems.length).map((s) => (
        <section key={s.id} className="card review-section">
          <div className="section-head">
            <h2>{s.title} <span className="count">{s.problems.length}</span></h2>
          </div>
          <p className="muted small">{s.hint}</p>
          {s.problems.length === 0 ? <p className="empty">None.</p> : (
            <ul className="review-items">
              {s.problems.map((p) => (
                <li key={p.ref}>
                  <Link to={`/problems/${p.ref}`} className="mono">{p.ref}</Link>
                  <Link to={`/problems/${p.ref}`} className="review-title">{p.title}</Link>
                  <span className="review-meta">
                    <PriorityBadge priority={p.priority} />
                    <StatusBadge kind="problem" status={p.status} />
                    {p.is_major && <MajorBadge />}
                    {s.id === 'review_due' && p.ec_review_date && <span className="due overdue">review {formatDay(p.ec_review_date)}</span>}
                    {s.id === 'stale' && <span className="muted small">updated {relativeTime(p.updated_at)}</span>}
                  </span>
                  <span className="review-owner">
                    {editable && p.assignee_id === null ? (
                      <select defaultValue="" onChange={(e) => e.target.value && assign(p.ref, Number(e.target.value))} aria-label={`Assign ${p.ref}`}>
                        <option value="">Assign…</option>
                        {meta.assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
                      </select>
                    ) : <span className="muted">{p.assignee ?? 'Unassigned'}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {data && (!hideEmpty || data.overdue_actions.length > 0) && (
        <section className="card">
          <h2>Overdue follow-up actions <span className="count">{data.overdue_actions.length}</span></h2>
          {data.overdue_actions.length === 0 ? <p className="empty">None.</p> : <ActionList actions={data.overdue_actions} editable={editable} showParent onChange={() => reload()} />}
        </section>
      )}
    </>
  );
}
