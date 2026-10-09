import { Link } from 'react-router';
import { api, type Action, type ProblemDetail, type Status } from '../api';
import { ActionList } from '../components/Actions';
import { PriorityBadge, StatusBadge } from '../components/Badges';
import { isGuided } from '../components/Guide';
import { relativeTime } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';

interface MyWork {
  problems: { ref: string; title: string; status: Status; priority: number; updated_at: string; url: string }[];
  actions: Action[];
  watched_changes: { ref: string; title: string; kind: string; body: string; created_at: string; by: string | null }[];
  decisions: { ref: string; title: string; priority: number; known_error_at: string }[];
  approvals: { id: number; ref: string; title: string; summary: string; requested_by: string; created_at: string; human_confirmation: string }[];
}

/** One calm place for everything that needs me, most urgent first. */
export function MyWorkPage() {
  const { user, setPreferences } = useSession();
  const { data, reload } = useApi<MyWork>('/api/my-work');
  if (!data) return null;
  const decide = async (id: number, approve: boolean) => {
    await api.post<ProblemDetail>(`/api/approvals/${id}/${approve ? 'approve' : 'reject'}`, {});
    reload();
  };
  const nothing = !data.problems.length && !data.actions.length && !data.decisions.length && !data.approvals.length;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>My work</h1>
          <p className="muted">Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, {user.display_name.split(' ')[0]}. {nothing ? 'Nothing needs you right now.' : 'This is what needs you, most urgent first.'}</p>
        </div>
        <Link className="btn" to="/dashboard">Dashboard</Link>
      </header>

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
