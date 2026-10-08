import { Link } from 'react-router';
import type { Action, Activity, Problem, Status } from '../api';
import { ActionList } from '../components/Actions';
import { ProblemTable } from '../components/ProblemTable';
import { PRIORITY_LABEL, relativeTime, STATUS_LABEL, STATUS_PHASE } from '../format';
import { useApi } from '../hooks';
import { isManager, useSession } from '../session';
import type { BackupStatus } from './Admin';
import { isGuided } from '../components/Guide';
import { ActivityLine } from './Problem';

interface Dashboard {
  by_status: Partial<Record<Status, number>>;
  open_by_priority: { priority: number; count: number }[];
  open_summary: { under_30: number; d30_90: number; over_90: number; major: number; unassigned: number; needs_decision: number; review_due: number };
  open_links_by_kind: Partial<Record<string, number>>;
  my_problems: Problem[];
  my_actions: Action[];
  actions: { open: number; overdue: number };
  watched_activity: Activity[];
  recent_activity: Activity[];
}

export function DashboardPage() {
  const { user, setPreferences } = useSession();
  const { data, error, reload } = useApi<Dashboard>('/api/dashboard');
  const { data: backups } = useApi<BackupStatus>(isManager(user) ? '/api/admin/backups' : null);
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

      {isGuided(user.preferences) && !user.preferences.intro_seen && (
        <div className="banner intro">
          <div>
            <strong>New to problem management?</strong> Take five minutes to see how the process works and how Kernel guides you through it.
          </div>
          <div className="banner-actions">
            <Link className="btn primary small" to="/guide">Show me</Link>
            <button className="btn small" onClick={() => setPreferences({ intro_seen: true })}>Dismiss</button>
          </div>
        </div>
      )}

      {backups?.configured && !backups.healthy && (
        <Link to="/admin" className="banner warn">
          Backups need attention: {backups.last_success ? `last successful backup ${relativeTime(backups.last_success)}` : 'no successful backup yet'}.
        </Link>
      )}

      <section className="stat-row">
        <Link to="/problems" className="stat">
          <span className="stat-label">Open problems</span>
          <span className="stat-value">{open}</span>
        </Link>
        {(['new', 'analysis', 'known_error'] as Status[]).map((s) => (
          <Link to={`/problems?status=${s}`} key={s} className={`stat stat-${s}`}>
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
        <Link to="/problems?needs_decision=true" className="stat">
          <span className="stat-label">Awaiting decision</span>
          <span className="stat-value">{data.open_summary.needs_decision}</span>
          <span className="stat-sub">known errors{data.open_summary.review_due ? ` · ${data.open_summary.review_due} review due` : ''}</span>
        </Link>
        <Link to="/actions?everyone=1&overdue=true" className={`stat ${data.actions.overdue ? 'stat-alert' : ''}`}>
          <span className="stat-label">Overdue actions</span>
          <span className="stat-value">{data.actions.overdue}</span>
          <span className="stat-sub">of {data.actions.open} open</span>
        </Link>
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

      <div className="grid-2 wide-left">
        <section className="card">
          <h2>Problems assigned to me</h2>
          <ProblemTable problems={data.my_problems} empty="Nothing assigned to you." compact />
        </section>
        <section className="card">
          <div className="section-head">
            <h2>My open actions</h2>
            <Link to="/actions" className="small">All actions →</Link>
          </div>
          {data.my_actions.length === 0 && <p className="empty">No open actions.</p>}
          <ActionList actions={data.my_actions} editable showProblem onChange={() => reload()} />
        </section>
      </div>

      {data.watched_activity.length > 0 && (
        <section className="card">
          <h2>Changes on problems I watch</h2>
          <ul className="activity">
            {data.watched_activity.map((a) => (
              <li key={a.id}>
                <ActivityLine activity={a} />
                <Link className="activity-ref" to={`/problems/${a.ref}`}><span className="mono">{a.ref}</span> {a.title}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Recent activity</h2>
        {data.recent_activity.length === 0 && <p className="empty">No activity yet.</p>}
        <ul className="activity">
          {data.recent_activity.slice(0, 10).map((a) => (
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
