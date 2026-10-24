import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, type ProblemDetail } from '../../api/client';
import { ActionList } from '../../components/Actions';
import { ApprovalDetails } from '../../components/ApprovalDetails';
import { PriorityBadge, StatusBadge } from '../../components/Badges';
import { isGuided } from '../../components/Guide';
import { relativeTime } from '../../format';
import { useLive } from '../../hooks/useLive';
import { useApi } from '../../hooks';
import { focusPractice, type Practice } from '../../nav';
import { StartPageSelects } from '../../components/StartPage';
import { canEdit, useSession } from '../../session';
import type { MyWork } from '../../api/types/work';

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
  // The person's own practice first (#171); the rest in the usual order.
  const focus = focusPractice(user);
  const sections: [string, Practice, ReactNode][] = [
    ['decisions', 'problem',
      data.decisions.length > 0 && (
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
      ),
    ],
    ['change_votes', 'change',
      data.change_votes.length > 0 && (
        <section className="card">
          <h2>Changes waiting for your approval <span className="count">{data.change_votes.length}</span></h2>
          <ul className="work-list">
            {data.change_votes.map((c) => (
              <li key={c.ref}><div><Link to={`/changes/${c.ref}`} className="mono">{c.ref}</Link> {c.title}</div><span className="work-meta"><span className="tag">{c.change_type}</span>{c.planned_start && <span className="muted small">{relativeTime(c.planned_start)}</span>}</span></li>
            ))}
          </ul>
        </section>
      ),
    ],
    ['major_updates', 'incident',
      !!data.major_updates?.length && (
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
      ),
    ],
    ['reviews', 'incident',
      !!data.reviews?.length && (
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
      ),
    ],
    ['improvements', 'improvement',
      !!data.improvements?.length && (
        <section className="card">
          <h2>My improvements <span className="count">{data.improvements.length}</span></h2>
          <ul className="work-list">
            {data.improvements.map((m) => (
              <li key={m.ref}>
                <div><Link to={`/improvements/${m.ref}`} className="mono">{m.ref}</Link> <Link to={`/improvements/${m.ref}`} className="work-title">{m.title}</Link></div>
                <span className="work-meta"><span className="muted small">{m.status === 'in_progress' ? 'in progress' : m.status}</span></span>
              </li>
            ))}
          </ul>
        </section>
      ),
    ],
    ['incidents', 'incident',
      data.incidents.length > 0 && (
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
      ),
    ],
    ['team_queue', 'incident',
      !!data.team_queue?.length && (
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
      ),
    ],
    ['requests', 'request',
      (!!data.request_approvals?.length || !!data.request_tasks?.length || !!data.request_queue?.length) && (
        <section className="card">
          <h2>Service requests <span className="count">{(data.request_approvals?.length ?? 0) + (data.request_tasks?.length ?? 0) + (data.request_queue?.length ?? 0)}</span> <Link to="/requests" className="btn-link small">All requests</Link></h2>
          <ul className="work-list">
            {data.request_approvals?.map((r) => (
              <li key={`a${r.ref}`}>
                <div><Link to={`/requests/${r.ref}`} className="mono">{r.ref}</Link> <Link to={`/requests/${r.ref}`} className="work-title">{r.title}</Link></div>
                <span className="work-meta"><span className="badge req-awaiting_approval">Needs your approval</span></span>
              </li>
            ))}
            {data.request_tasks?.map((r) => (
              <li key={`t${r.task_id}`}>
                <div><Link to={`/requests/${r.ref}`} className="mono">{r.ref}</Link> <Link to={`/requests/${r.ref}`} className="work-title">{r.task}</Link></div>
                <span className="work-meta"><span className="muted small">{r.title}</span></span>
              </li>
            ))}
            {data.request_queue?.map((r) => (
              <li key={`q${r.task_id}`}>
                <div><Link to={`/requests/${r.ref}`} className="mono">{r.ref}</Link> <Link to={`/requests/${r.ref}`} className="work-title">{r.task}</Link></div>
                <span className="work-meta">{r.at_risk && <span className="badge overdue">SLA</span>}<span className="muted small">{r.team} queue</span></span>
              </li>
            ))}
          </ul>
        </section>
      ),
    ],
    ['problems', 'problem',
      (focus === 'problem' || data.problems.length > 0 || data.actions.length > 0) && (
        <div className="grid-2 wide-left">
          <section className="card">
            <h2>My problems <span className="count">{data.problems.length}</span></h2>
            {data.problems.length === 0 && <p className="empty">No open problems assigned to you.</p>}
            <ul className="work-list">
              {data.problems.map((p) => (
                <li key={p.ref}>
                  <div><Link to={`/problems/${p.ref}`} className="mono">{p.ref}</Link> <Link to={`/problems/${p.ref}`} className="work-title">{p.title}</Link></div>
                  <span className="work-meta"><PriorityBadge priority={p.priority} /><StatusBadge kind="problem" status={p.status} /></span>
                </li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h2>My actions <span className="count">{data.actions.length}</span></h2>
            {data.actions.length === 0 && <p className="empty">No open actions.</p>}
            <ActionList actions={data.actions} editable showParent onChange={() => reload()} />
          </section>
        </div>
      ),
    ],
    ['changes', 'change',
      data.changes.length > 0 && (
        <section className="card">
          <h2>My changes <span className="count">{data.changes.length}</span></h2>
          <ul className="work-list">
            {data.changes.map((c) => (
              <li key={c.ref}><div><Link to={`/changes/${c.ref}`} className="mono">{c.ref}</Link> {c.title}</div><span className="work-meta"><span className="tag">{c.change_type}</span><span className="muted small">{c.status}</span></span></li>
            ))}
          </ul>
        </section>
      ),
    ],
    ['watched', 'problem',
      data.watched_changes.length > 0 && (
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
      ),
    ],
  ];
  const ordered = [...sections.filter(([, p]) => p === focus), ...sections.filter(([, p]) => p !== focus)];
  const nothing = !data.request_tasks?.length && !data.request_approvals?.length && !data.request_queue?.length && !data.reviews?.length && !data.improvements?.length && !data.major_updates?.length && !data.problems.length && !data.incidents.length && !data.team_queue?.length && !data.change_votes.length && !data.changes.length && !data.actions.length && !data.decisions.length && !data.approvals.length;
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

      {!user.preferences.start_seen && (
        <div className="banner intro">
          <div>
            <strong>Where do you start?</strong> Choose the page Kernel opens on and what "+ New" creates first. You can change it any time in Settings.
            <StartPageSelects
              value={{ home: user.preferences.home, default_new: user.preferences.default_new }}
              meta={meta}
              creates={canEdit(user)}
              inherit={{ home: 'Default for your role', default_new: 'Default for your role' }}
              onChange={(c) => setPreferences(c)}
            />
          </div>
          <div className="banner-actions"><button className="btn primary small" onClick={() => setPreferences({ start_seen: true })}>Done</button></div>
        </div>
      )}

      {user.preferences.start_seen && isGuided(user.preferences) && !user.preferences.intro_seen && (
        <div className="banner intro">
          <div><strong>New to Kernel?</strong> Take five minutes to see how the practices fit together and how Kernel guides you through them.</div>
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

      {ordered.map(([key, , node]) => <Fragment key={key}>{node}</Fragment>)}
    </>
  );
}
