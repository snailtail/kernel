import { Link } from 'react-router';
import type { Activity, Problem, Status } from '../api';
import { ProblemTable } from '../components/ProblemTable';
import { PRIORITY_LABEL, STATUS_LABEL, STATUS_PHASE } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { ActivityLine } from './Problem';

interface Dashboard {
  by_status: Partial<Record<Status, number>>;
  open_by_priority: { priority: number; count: number }[];
  open_summary: { under_30: number; d30_90: number; over_90: number; major: number; unassigned: number };
  open_links_by_kind: Partial<Record<string, number>>;
  my_problems: Problem[];
  recent_activity: Activity[];
}

export function DashboardPage() {
  const { user } = useSession();
  const { data, error } = useApi<Dashboard>('/api/dashboard');
  if (error) return <div className="error">{error}</div>;
  if (!data) return null;

  const open = (['new', 'analysis', 'known_error'] as Status[]).reduce((n, s) => n + (data.by_status[s] ?? 0), 0);
  const maxPrio = Math.max(1, ...data.open_by_priority.map((p) => p.count));

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Welcome back, {user.display_name}.</p>
        </div>
      </header>

      <section className="stat-row">
        <Link to="/problems" className="stat">
          <span className="stat-label">Open problems</span>
          <span className="stat-value">{open}</span>
        </Link>
        {(['new', 'analysis', 'known_error'] as Status[]).map((s) => (
          <Link to={`/problems?status=${s}`} key={s} className="stat">
            <span className="stat-label">{STATUS_LABEL[s]}</span>
            <span className="stat-value">{data.by_status[s] ?? 0}</span>
            <span className="stat-sub">{STATUS_PHASE[s]}</span>
          </Link>
        ))}
        <Link to="/problems?is_major=true" className="stat">
          <span className="stat-label">Major problems</span>
          <span className="stat-value">{data.open_summary.major}</span>
          <span className="stat-sub">open</span>
        </Link>
        <div className="stat">
          <span className="stat-label">Unassigned</span>
          <span className="stat-value">{data.open_summary.unassigned}</span>
          <span className="stat-sub">open</span>
        </div>
      </section>

      <div className="grid-2">
        <section className="card">
          <h2>Open by priority</h2>
          {data.open_by_priority.length === 0 && <p className="empty">Nothing open.</p>}
          <div className="bars">
            {data.open_by_priority.map((p) => (
              <Link to={`/problems?priority=${p.priority}`} key={p.priority} className="bar-row">
                <span className="bar-label">P{p.priority} {PRIORITY_LABEL[p.priority]}</span>
                <span className="bar-track">
                  <span className={`bar-fill prio-fill-${p.priority}`} style={{ width: `${(p.count / maxPrio) * 100}%` }} />
                </span>
                <span className="bar-value">{p.count}</span>
              </Link>
            ))}
          </div>
        </section>
        <section className="card">
          <h2>Backlog health</h2>
          <dl className="kv">
            <dt>Opened &lt; 30 days ago</dt>
            <dd>{data.open_summary.under_30}</dd>
            <dt>30–90 days old</dt>
            <dd>{data.open_summary.d30_90}</dd>
            <dt>Older than 90 days</dt>
            <dd className={data.open_summary.over_90 ? 'warn' : ''}>{data.open_summary.over_90}</dd>
            <dt>Linked incidents (open problems)</dt>
            <dd>{data.open_links_by_kind.incident ?? 0}</dd>
            <dt>Linked events (open problems)</dt>
            <dd>{data.open_links_by_kind.event ?? 0}</dd>
            <dt>Resolved, awaiting closure</dt>
            <dd>{data.by_status.resolved ?? 0}</dd>
          </dl>
        </section>
      </div>

      <section className="card">
        <h2>Assigned to me</h2>
        <ProblemTable problems={data.my_problems} empty="Nothing assigned to you." />
      </section>

      <section className="card">
        <h2>Recent activity</h2>
        {data.recent_activity.length === 0 && <p className="empty">No activity yet.</p>}
        <ul className="activity">
          {data.recent_activity.map((a) => (
            <li key={a.id}>
              <ActivityLine activity={a} />
              <Link className="activity-ref" to={`/problems/${a.ref}`}>
                <span className="mono">{a.ref}</span> {a.title}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
