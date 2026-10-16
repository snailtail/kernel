import { Link } from 'react-router';
import { api, type Action, type ProblemDetail, type Status } from '../api';
import { ActionList } from '../components/Actions';
import { ApprovalDetails } from '../components/ApprovalDetails';
import { PriorityBadge, StatusBadge } from '../components/Badges';
import { isGuided } from '../components/Guide';
import { relativeTime } from '../format';
import { useLive } from '../live';
import { useApi } from '../hooks';
import { useSession } from '../session';

interface MyWork {
  problems: { ref: string; title: string; status: Status; priority: number; updated_at: string; url: string }[];
  incidents: { ref: string; title: string; status: string; priority: number; is_major: boolean; created_at: string; update_overdue?: boolean }[];
  reviews?: { ref: string; incident_ref: string; title: string; status: string; due: string | null; overdue: boolean }[];
  major_updates?: { ref: string; title: string; priority: number; next_update_at: string | null; update_overdue: boolean; role: string }[];
  teams?: { id: number; name: string; role: string; unassigned: number }[];
  team_queue?: { ref: string; title: string; status: string; priority: number; is_major: boolean; created_at: string; team: string }[];
  change_votes: { ref: string; title: string; change_type: string; planned_start: string | null }[];
  changes: { ref: string; title: string; status: string; change_type: string; planned_start: string | null }[];
  actions: Action[];
  watched_changes: { ref: string; title: string; kind: string; body: string; created_at: string; by: string | null }[];
  decisions: { ref: string; title: string; priority: number; known_error_at: string }[];
  approvals: { id: number; ref: string; title: string; summary: string; payload: Record<string, unknown>; requested_by: string; created_at: string; human_confirmation: string; changed_since_request: boolean }[];
}

/** One calm place for everything that needs me, most urgent first. */
export function MyWorkPage() {
  const { user, meta, setPreferences } = useSession();
  const { data, reload, refresh } = useApi<MyWork>('/api/my-work');
  useLive(['problem:*', 'incident:*', 'change:*'], refresh);
  if (!data) return null;
  const decide = async (id: number, approve: boolean) => {
    await api.post<ProblemDetail>(`/api/approvals/${id}/${approve ? 'approve' : 'reject'}`, {});
    reload();
  };
  const nothing = !data.reviews?.length && !data.major_updates?.length && !data.problems.length && !data.incidents.length && !data.team_queue?.length && !data.change_votes.length && !data.changes.length && !data.actions.length && !data.decisions.length && !data.approvals.length;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>My work</h1>
          <p className="muted">Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, {user.display_name.split(' ')[0]}. {nothing ? 'Nothing needs you right now.' : 'This is what needs you, most urgent first.'}</p>
        </div>
        <Link className="btn" to="/dashboard">Dashboard</Link>
      </header>

      {user.role === 'admin' && meta.setup_completed === false && (
        <div className="banner intro">
          <div><strong>Welcome to Kernel.</strong> Choose what Kernel should help with, your support hours and a first monitoring source – a minute, and every step can be skipped.</div>
          <div className="banner-actions"><Link className="btn primary small" to="/setup">Set up Kernel</Link></div>
        </div>
      )}

      {isGuided(user.preferences) && !user.preferences.intro_seen && (
        <div className="banner intro">
          <div><strong>New to problem management?</strong> Take five minutes to see how the process works and how Kernel guides you through it.</div>
          <div className="banner-actions">
            <Link className="btn primary small" to="/guide">Show me</Link>
            <button className="btn small" onClick={() => setPreferences({ intro_seen: true })}>Dismiss</button>
          </div>
        </div>
      )}

      {data.approvals.length > 0 && (
        <section className="card">
          <h2>Waiting for your approval <span className="count">{data.approvals.length}</span></h2>
          <p className="muted small">Decisions AI agents asked for through MCP. Nothing happens until a person approves.</p>
          <ul className="work-list">
            {data.approvals.map((a) => (
              <li key={a.id}>
                <div>
                  <Link to={`/problems/${a.ref}`} className="mono">{a.ref}</Link> <strong>{a.summary}</strong>
                  <div className="muted small">{a.title} · requested by {a.requested_by}'s agent {relativeTime(a.created_at)}</div>
                  <ApprovalDetails payload={a.payload} changedSince={a.changed_since_request} />
                </div>
                <span className="approval-actions">
                  <button className="btn small" onClick={() => decide(a.id, false)}>Reject</button>
                  <button className="btn small primary" onClick={() => decide(a.id, true)}>Approve</button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.decisions.length > 0 && (
        <section className="card">
          <h2>Known errors awaiting your decision <span className="count">{data.decisions.length}</span></h2>
          <ul className="work-list">
            {data.decisions.map((d) => (
              <li key={d.ref}>
                <div><Link to={`/problems/${d.ref}`} className="mono">{d.ref}</Link> {d.title}</div>
                <span className="work-meta"><PriorityBadge priority={d.priority} /><span className="muted small">known error {relativeTime(d.known_error_at)}</span></span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.change_votes.length > 0 && (
        <section className="card">
          <h2>Changes waiting for your approval <span className="count">{data.change_votes.length}</span></h2>
          <ul className="work-list">
            {data.change_votes.map((c) => (
              <li key={c.ref}><div><Link to={`/changes/${c.ref}`} className="mono">{c.ref}</Link> {c.title}</div><span className="work-meta"><span className="tag">{c.change_type}</span>{c.planned_start && <span className="muted small">{relativeTime(c.planned_start)}</span>}</span></li>
            ))}
          </ul>
        </section>
      )}

      {!!data.major_updates?.length && (
        <section className="card">
          <h2>Stakeholder updates <span className="count">{data.major_updates.length}</span></h2>
          <ul className="work-list">
            {data.major_updates.map((m) => (
              <li key={m.ref}>
                <div><Link to={`/incidents/${m.ref}`} className="mono">{m.ref}</Link> <Link to={`/incidents/${m.ref}`} className="work-title">{m.title}</Link> <span className="muted small">you are the {m.role}</span></div>
                <span className="work-meta">{m.update_overdue ? <span className="badge overdue">Update overdue</span> : m.next_update_at && <span className="muted small">next update {relativeTime(m.next_update_at)}</span>}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!!data.reviews?.length && (
        <section className="card">
          <h2>Post-incident reviews <span className="count">{data.reviews.length}</span></h2>
          <ul className="work-list">
            {data.reviews.map((r) => (
              <li key={r.ref}>
                <div><Link to={`/incidents/${r.incident_ref}/review`} className="mono">{r.incident_ref}</Link> <Link to={`/incidents/${r.incident_ref}/review`} className="work-title">{r.title}</Link></div>
                <span className="work-meta">{r.overdue ? <span className="badge overdue">Overdue</span> : r.due && <span className="muted small">due {r.due}</span>}<span className="muted small">{r.status}</span></span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.incidents.length > 0 && (
        <section className="card">
          <h2>My incidents <span className="count">{data.incidents.length}</span></h2>
          <ul className="work-list">
            {data.incidents.map((i) => (
              <li key={i.ref}>
                <div><Link to={`/incidents/${i.ref}`} className="mono">{i.ref}</Link> <Link to={`/incidents/${i.ref}`} className="work-title">{i.title}</Link></div>
                <span className="work-meta">{i.update_overdue && <span className="badge overdue">Update overdue</span>}{i.is_major && <span className="badge major">Major</span>}<PriorityBadge priority={i.priority} /><span className="muted small">{i.status.replace('_', ' ')}</span></span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!!data.team_queue?.length && (
        <section className="card">
          <h2>Waiting in my teams' queues <span className="count">{data.team_queue.length}</span> <Link to="/teams" className="btn-link small">Teams</Link></h2>
          <ul className="work-list">
            {data.team_queue.map((i) => (
              <li key={i.ref}>
                <div><Link to={`/incidents/${i.ref}`} className="mono">{i.ref}</Link> <Link to={`/incidents/${i.ref}`} className="work-title">{i.title}</Link></div>
                <span className="work-meta">{i.is_major && <span className="badge major">Major</span>}<PriorityBadge priority={i.priority} /><span className="muted small">{i.team}</span></span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid-2 wide-left">
        <section className="card">
          <h2>My problems <span className="count">{data.problems.length}</span></h2>
          {data.problems.length === 0 && <p className="empty">No open problems assigned to you.</p>}
          <ul className="work-list">
            {data.problems.map((p) => (
              <li key={p.ref}>
                <div><Link to={`/problems/${p.ref}`} className="mono">{p.ref}</Link> <Link to={`/problems/${p.ref}`} className="work-title">{p.title}</Link></div>
                <span className="work-meta"><PriorityBadge priority={p.priority} /><StatusBadge status={p.status} /></span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>My actions <span className="count">{data.actions.length}</span></h2>
          {data.actions.length === 0 && <p className="empty">No open actions.</p>}
          <ActionList actions={data.actions} editable showProblem onChange={() => reload()} />
        </section>
      </div>

      {data.changes.length > 0 && (
        <section className="card">
          <h2>My changes <span className="count">{data.changes.length}</span></h2>
          <ul className="work-list">
            {data.changes.map((c) => (
              <li key={c.ref}><div><Link to={`/changes/${c.ref}`} className="mono">{c.ref}</Link> {c.title}</div><span className="work-meta"><span className="tag">{c.change_type}</span><span className="muted small">{c.status}</span></span></li>
            ))}
          </ul>
        </section>
      )}

      {data.watched_changes.length > 0 && (
        <section className="card">
          <h2>Changes on what you watch</h2>
          <ul className="work-list">
            {data.watched_changes.map((c, i) => (
              <li key={i}>
                <div>
                  <Link to={`/problems/${c.ref}`} className="mono">{c.ref}</Link> {c.title}
                  <div className="muted small">{c.by ?? 'System'}: {c.kind === 'comment' ? 'added a note' : (c.body || c.kind).slice(0, 120)}</div>
                </div>
                <span className="muted small">{relativeTime(c.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
