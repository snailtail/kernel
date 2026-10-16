import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { formatDate, relativeTime } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';

interface SecurityEvent {
  id: number;
  at: string;
  action: string;
  category: string;
  outcome: 'success' | 'failure' | 'denied' | 'blocked' | 'info';
  severity: string;
  user_id: number | null;
  user_name: string | null;
  username: string | null;
  account: string;
  actor_type: string;
  channel: string;
  token_prefix: string;
  ip: string | null;
  country: string;
  user_agent: string;
  request_id: string;
  target: string;
  detail: Record<string, unknown>;
  message: string;
}

interface Summary {
  outcomes: Record<string, number>;
  top: { action: string; outcome: string; n: number }[];
}

const FILTERS = ['action', 'category', 'outcome', 'min_severity', 'user', 'ip', 'token_prefix', 'from', 'to'] as const;
const CATEGORIES = ['authentication', 'authorization', 'iam', 'configuration', 'data_access', 'web', 'network', 'integrity', 'api'];
const OUTCOMES = ['success', 'failure', 'denied', 'blocked', 'info'];
const SEVERITIES = ['warning', 'minor', 'major', 'critical'];
const PROBLEMS = ['failure', 'denied', 'blocked'] as const;
const OUTCOME_LABEL: Record<string, string> = { failure: 'Failures', denied: 'Denied', blocked: 'Blocked' };

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '–' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function SecurityEventsPage() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState(() => Object.fromEntries(FILTERS.map((f) => [f, params.get(f) ?? ''])) as Record<string, string>);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: summary } = useApi<Summary>('/api/security-events/summary');
  const filterQuery = new URLSearchParams(Object.fromEntries(FILTERS.filter((f) => params.get(f)).map((f) => [f, params.get(f)!])));

  const load = async (beforeId?: number) => {
    setError(null);
    try {
      const q = new URLSearchParams(filterQuery);
      q.set('limit', '100');
      if (beforeId) q.set('before_id', String(beforeId));
      const rows = await api.get<SecurityEvent[]>(`/api/security-events?${q}`);
      setEvents((prev) => (beforeId ? [...prev, ...rows] : rows));
      setMore(rows.length === 100);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.toString()]);

  if (user.role !== 'admin') return <p className="empty">Security events are available to administrators.</p>;

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    setParams(Object.fromEntries(Object.entries(draft).filter(([, v]) => v.trim())), { replace: true });
  };
  const filterBy = (next: Record<string, string>) => {
    setDraft(Object.fromEntries(FILTERS.map((f) => [f, next[f] ?? ''])));
    setParams(next, { replace: true });
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Security events</h1>
          <p className="muted">Sign-ins, failures, denials, new token addresses, role and credential changes, exports and blocked requests. Kept for a year, apart from the audit trail.</p>
        </div>
        <div className="head-actions">
          <Link className="btn" to="/admin/audit">Audit trail</Link>
        </div>
      </header>
      {summary && (
        <section className="stat-row security-summary" aria-label="Last 24 hours">
          {PROBLEMS.map((o) => (
            <button key={o} type="button" className="stat" onClick={() => filterBy({ outcome: o })}>
              <span className="stat-label">{OUTCOME_LABEL[o]}</span>
              <span className={`stat-value${summary.outcomes[o] ? ' attention' : ''}`}>{summary.outcomes[o] ?? 0}</span>
              <span className="stat-sub">last 24 hours</span>
            </button>
          ))}
          <div className="stat">
            <span className="stat-label">Most frequent</span>
            {summary.top.length === 0 ? <span className="stat-sub">Nothing failed, denied or blocked.</span> : (
              <ul className="plain-list">
                {summary.top.slice(0, 4).map((t) => (
                  <li key={`${t.action}-${t.outcome}`}>
                    <button type="button" className="btn-link" onClick={() => filterBy({ action: t.action, outcome: t.outcome })}>{t.action}</button> <span className="muted small">{t.n}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
      <form className="filters audit-filters" onSubmit={apply}>
        <input placeholder="Action, e.g. auth.login_failed" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
        <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} aria-label="Category">
          <option value="">Any category</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
        </select>
        <select value={draft.outcome} onChange={(e) => setDraft({ ...draft, outcome: e.target.value })} aria-label="Outcome">
          <option value="">Any outcome</option>
          {OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <select value={draft.min_severity} onChange={(e) => setDraft({ ...draft, min_severity: e.target.value })} aria-label="Severity">
          <option value="">Any severity</option>
          {SEVERITIES.map((s) => <option key={s} value={s}>{s} or higher</option>)}
        </select>
        <input placeholder="User" value={draft.user} onChange={(e) => setDraft({ ...draft, user: e.target.value })} />
        <input placeholder="IP" value={draft.ip} onChange={(e) => setDraft({ ...draft, ip: e.target.value })} />
        <input placeholder="Token prefix" value={draft.token_prefix} onChange={(e) => setDraft({ ...draft, token_prefix: e.target.value })} />
        <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} aria-label="From" />
        <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} aria-label="To" />
        <button className="btn primary">Filter</button>
        {params.toString() && <button type="button" className="btn-link" onClick={() => filterBy({})}>Clear</button>}
      </form>
      {error && <div className="error">{error}</div>}
      <section className="card flush">
        {events.length === 0 ? <p className="empty">No security events match.</p> : (
          <div className="table-wrap">
            <table className="table compact audit-table">
              <thead><tr><th>When</th><th>Event</th><th>Who</th><th>From</th><th>Target</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className={open === e.id ? 'open' : ''} onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <td className="nowrap" title={formatDate(e.at)}>{relativeTime(e.at)}</td>
                    <td>
                      <span className={`tag outcome-${e.outcome}`}>{e.outcome}</span> <strong>{e.action}</strong>
                      {e.severity !== 'info' && <> <span className={`tag sev-${e.severity}`}>{e.severity}</span></>}
                      <div className="muted small">{e.message}</div>
                      {open === e.id && (
                        <dl className="audit-changes">
                          {Object.entries(e.detail ?? {}).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{show(v)}</dd></div>)}
                          <div><dt>category</dt><dd>{e.category}</dd></div>
                          {e.request_id && <div><dt>request</dt><dd className="mono">{e.request_id}</dd></div>}
                        </dl>
                      )}
                    </td>
                    <td>
                      {e.user_name ?? (e.account ? <span className="muted" title="A sign-in name that matches no account, stored as a digest">unknown account</span> : <span className="muted">–</span>)}
                      <div className="muted small">{e.actor_type}{e.token_prefix && <span className="mono"> · {e.token_prefix}…</span>}</div>
                    </td>
                    <td className="small">
                      {e.ip ? <button type="button" className="btn-link mono" onClick={(ev) => { ev.stopPropagation(); filterBy({ ip: e.ip! }); }}>{e.ip}</button> : '–'}
                      {e.country && <span className="muted"> · {e.country}</span>}
                      <div className="muted">{e.channel}</div>
                      {open === e.id && e.user_agent && <div className="muted">{e.user_agent}</div>}
                    </td>
                    <td className="small mono">{e.target || <span className="muted">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {more && <button className="btn" onClick={() => load(events[events.length - 1].id)}>Load older events</button>}
    </>
  );
}
