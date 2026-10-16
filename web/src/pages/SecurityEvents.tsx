import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { askReason } from '../components/Ask';
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
          <p className="muted">Sign-ins, failures, denials, new token addresses, role and credential changes, exports and blocked requests. Kept apart from the audit trail; detection rules turn the suspicious ones into alerts.</p>
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
      <SecurityAlerting />
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

// ---- Alerting (part 2 of #64) -------------------------------------------------------------------

interface Counting { enabled: boolean; threshold: number; window_minutes: number; rows?: number }
interface Alerting {
  enabled: boolean;
  failed_sign_ins: Counting;
  denials: Counting;
  bulk_export: Counting & { rows: number };
  new_country: { enabled: boolean };
  new_admin: { enabled: boolean };
  credential_change: { enabled: boolean };
}
interface AlertingStatus {
  settings: Alerting;
  source: string;
  rules: { id: number; name: string; enabled: boolean; min_severity: string | null; team_id: number | null; team_name: string | null }[];
  open_alerts: { id: number; check_key: string; severity: string; message: string; count: number; last_seen: string; incident_ref: string | null }[];
}
interface Privacy { audit_context_days: number; security_event_days: number }

const COUNTING: [keyof Alerting, string, string][] = [
  ['failed_sign_ins', 'Failed sign-ins', 'for one account, or from one address'],
  ['denials', 'Denied requests', 'from one token, user or address'],
  ['bulk_export', 'Exports', 'by one person'],
];
const ONE_OFF: [keyof Alerting, string][] = [
  ['new_country', 'A sign-in from a country the account has not used before (needs Cloudflare in front)'],
  ['new_admin', 'Someone becomes an administrator'],
  ['credential_change', 'Keys, single sign-on, AI providers, connectors, webhooks or event and dev sources change'],
];

function SecurityAlerting() {
  const { data, reload } = useApi<AlertingStatus>('/api/admin/security-alerting');
  const { data: privacy, reload: reloadPrivacy } = useApi<Privacy>('/api/admin/privacy');
  const [draft, setDraft] = useState<Alerting | null>(null);
  const [keep, setKeep] = useState<Privacy | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (data) setDraft(data.settings); }, [data]);
  useEffect(() => { if (privacy) setKeep(privacy); }, [privacy]);
  if (!data || !draft) return null;

  const rule = data.rules[0];
  const changed = JSON.stringify(draft) !== JSON.stringify(data.settings);
  const set = (key: keyof Alerting, patch: object) => setDraft({ ...draft, [key]: { ...(draft[key] as object), ...patch } });
  const save = async () => {
    const reason = await askReason('Change security alerting', 'Detection rules decide which security events become alerts and incidents.', { confirmLabel: 'Save rules' });
    if (!reason) return;
    try { await api.put('/api/admin/security-alerting', { ...draft, reason }); setError(null); reload(); } catch (err) { setError((err as Error).message); }
  };
  const saveRetention = async () => {
    if (!keep) return;
    const reason = await askReason('Change retention', `Security events will be kept for ${keep.security_event_days} days and the audit trail's IP addresses and browsers for ${keep.audit_context_days} days.`, { confirmLabel: 'Save retention' });
    if (!reason) return;
    try { await api.put('/api/admin/privacy', { ...keep, reason }); setError(null); reloadPrivacy(); } catch (err) { setError((err as Error).message); }
  };

  return (
    <section className="card security-alerting">
      <div className="section-head">
        <h2>Alerting</h2>
        <label className="check"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> On</label>
      </div>
      {data.open_alerts.length > 0 ? (
        <ul className="plain-list security-alerts">
          {data.open_alerts.map((a) => (
            <li key={a.id}>
              <span className={`tag sev-${a.severity}`}>{a.severity}</span> <strong>{a.check_key}</strong>
              {a.count > 1 && <span className="muted small"> · {a.count} times</span>}
              <span className="muted small"> · {relativeTime(a.last_seen)}</span>
              {a.incident_ref && <> · <Link to={`/incidents/${a.incident_ref}`}>{a.incident_ref}</Link></>}
              <div className="muted small">{a.message}</div>
            </li>
          ))}
        </ul>
      ) : <p className="muted">No open security alerts.</p>}
      <p className="muted small">
        {rule ? (
          <>Minor and worse alerts open a restricted security incident through the event rule <Link to="/events?tab=rules">{rule.name}</Link>
            {!rule.enabled && <strong> (turned off)</strong>}
            {rule.team_name ? <>, for the team {rule.team_name}.</> : <>. <strong>Choose the team that handles security incidents</strong> on that rule: until then security alerts open no incident.</>}
            {' '}Every new alert also notifies administrators.</>
        ) : <>No event rule names the source “{data.source}”, so security alerts never open incidents; administrators are still notified.</>}
      </p>
      <div className="table-wrap">
        <table className="table compact alerting-rules">
          <thead><tr><th>Rule</th><th>Alert at</th><th>Within</th></tr></thead>
          <tbody>
            {COUNTING.map(([key, label, who]) => {
              const c = draft[key] as Counting;
              return (
                <tr key={key}>
                  <td><label className="check"><input type="checkbox" checked={c.enabled} onChange={(e) => set(key, { enabled: e.target.checked })} /> {label}</label><div className="muted small">{who}</div></td>
                  <td>
                    <input type="number" min={2} aria-label={`${label}: threshold`} value={c.threshold} onChange={(e) => set(key, { threshold: Number(e.target.value) })} />
                    {key === 'bulk_export' && <div className="muted small">or one of <input type="number" min={10} aria-label="Rows in one export" value={c.rows} onChange={(e) => set(key, { rows: Number(e.target.value) })} /> rows</div>}
                  </td>
                  <td><input type="number" min={1} max={1440} aria-label={`${label}: minutes`} value={c.window_minutes} onChange={(e) => set(key, { window_minutes: Number(e.target.value) })} /> min</td>
                </tr>
              );
            })}
            {ONE_OFF.map(([key, label]) => (
              <tr key={key}>
                <td colSpan={3}><label className="check"><input type="checkbox" checked={(draft[key] as { enabled: boolean }).enabled} onChange={(e) => set(key, { enabled: e.target.checked })} /> {label}</label></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {changed && <div><button type="button" className="btn primary" onClick={save}>Save rules</button> <button type="button" className="btn-link" onClick={() => setDraft(data.settings)}>Undo</button></div>}
      {keep && (
        <div className="retention">
          <h3>Retention</h3>
          <p className="muted small">Kept for security under legitimate interest, also after a user is erased (at least 30 days).</p>
          <label>Security events <input type="number" min={30} max={3650} value={keep.security_event_days} onChange={(e) => setKeep({ ...keep, security_event_days: Number(e.target.value) })} /> days</label>
          <label>IP addresses and browsers in the audit trail <input type="number" min={30} max={3650} value={keep.audit_context_days} onChange={(e) => setKeep({ ...keep, audit_context_days: Number(e.target.value) })} /> days</label>
          {privacy && JSON.stringify(keep) !== JSON.stringify(privacy) && <button type="button" className="btn primary" onClick={saveRetention}>Save retention</button>}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}
