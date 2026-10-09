import { Link } from 'react-router';
import { useState } from 'react';
import { GroupedBars, HBars, LineChart } from '../components/Charts';
import { CLOSURE_LABEL, formatDay, PRIORITY_LABEL } from '../format';
import { useApi } from '../hooks';

interface Report {
  period: { from: string; to: string; bucket: 'week' | 'month' };
  summary: {
    opened: number; major_opened: number; known_errors_raised: number; resolved: number; closed: number;
    reopened: number; open_now: number; proactive: number; reactive: number;
  };
  flow: { bucket: string; opened: number; known_errors: number; resolved: number; closed: number }[];
  backlog: { at: string; open: number }[];
  lead_times: {
    priority: number; known_error_count: number; known_error_median_h: number | null; known_error_p90_h: number | null;
    resolved_count: number; resolved_median_h: number | null; resolved_p90_h: number | null;
  }[];
  closures: { closure_code: string; count: number }[];
  hotspots: {
    services: { name: string; incidents: number; events: number; open_problems: number }[];
    categories: { name: string; logged: number; open: number }[];
    cis: { ref: string; name: string; type_label: string; criticality: number; records: number; unlinked: number; open_problems: number; known_errors: number }[];
    ci_types: { name: string; records: number; problems: number }[];
  };
  known_errors: { count: number; avg_age_days: number; with_workaround: number; with_decision: number; risk_accepted: number; review_due: number };
  actions: { created: number; completed: number; on_time_rate: number | null; open_now: number; overdue_now: number };
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function preset(name: string): [string, string] {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3);
  switch (name) {
    case '30d': return [iso(new Date(now.getTime() - 29 * 86400000)), iso(now)];
    case 'quarter': return [iso(new Date(now.getFullYear(), q * 3, 1)), iso(now)];
    case 'last-quarter': return [iso(new Date(now.getFullYear(), q * 3 - 3, 1)), iso(new Date(now.getFullYear(), q * 3, 0))];
    case 'month': return [iso(new Date(now.getFullYear(), now.getMonth(), 1)), iso(now)];
    case 'last-month': return [iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), iso(new Date(now.getFullYear(), now.getMonth(), 0))];
    case 'year': return [iso(new Date(now.getFullYear(), 0, 1)), iso(now)];
    case '12m': return [iso(new Date(now.getFullYear() - 1, now.getMonth() + 1, 1)), iso(now)];
    default: return [iso(new Date(now.getTime() - 89 * 86400000)), iso(now)];
  }
}

const duration = (h: number | null) => (h === null ? '–' : h < 48 ? `${Math.round(h)} h` : `${(h / 24).toFixed(h < 240 ? 1 : 0)} d`);
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '–');

export function ReportsPage() {
  const [range, setRange] = useState<{ name: string; from: string; to: string }>(() => {
    const [from, to] = preset('90d');
    return { name: '90d', from, to };
  });
  const query = new URLSearchParams({ from: range.from, to: range.to });
  const { data: r, error, loading } = useApi<Report>(`/api/reports?${query}`);

  const choose = (name: string) => {
    if (name === 'custom') return setRange({ ...range, name });
    const [from, to] = preset(name);
    setRange({ name, from, to });
  };
  const bucketLabel = (b: string) => {
    const [y, m, d] = b.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return r?.period.bucket === 'month' ? date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Reports</h1>
          <p className="muted">How problem management is performing: flow, lead times, quality and where problems come from.</p>
        </div>
        <div className="head-actions no-print">
          <a className="btn" href={`/api/reports/problems.csv?${query}`}>Export CSV</a>
          <button className="btn" onClick={() => window.print()}>Print</button>
        </div>
      </header>

      <div className="filters no-print">
        <select value={range.name} onChange={(e) => choose(e.target.value)} aria-label="Period">
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          <option value="month">This month</option>
          <option value="last-month">Last month</option>
          <option value="quarter">This quarter</option>
          <option value="last-quarter">Last quarter</option>
          <option value="year">This year</option>
          <option value="12m">Last 12 months</option>
          <option value="custom">Custom…</option>
        </select>
        {range.name === 'custom' && (
          <>
            <input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} aria-label="From" />
            <span className="muted">to</span>
            <input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} aria-label="To" />
          </>
        )}
        {r && <span className="muted small">{formatDay(r.period.from)} – {formatDay(r.period.to)}</span>}
      </div>

      {error && <div className="error">{error}</div>}
      {r && (
        <div className={`reports ${loading ? 'is-loading' : ''}`}>
          <section className="stat-row">
            <div className="stat"><span className="stat-label">Logged</span><span className="stat-value">{r.summary.opened}</span><span className="stat-sub">{r.summary.major_opened} major</span></div>
            <div className="stat"><span className="stat-label">Known errors raised</span><span className="stat-value">{r.summary.known_errors_raised}</span></div>
            <div className="stat"><span className="stat-label">Resolved</span><span className="stat-value">{r.summary.resolved}</span></div>
            <div className="stat"><span className="stat-label">Closed</span><span className="stat-value">{r.summary.closed}</span></div>
            <div className="stat"><span className="stat-label">Reopened</span><span className="stat-value">{r.summary.reopened}</span></div>
            <div className="stat">
              <span className="stat-label">Proactive</span>
              <span className="stat-value">{pct(r.summary.proactive, r.summary.proactive + r.summary.reactive)}</span>
              <span className="stat-sub">{r.summary.proactive} of {r.summary.proactive + r.summary.reactive} logged</span>
            </div>
            <div className="stat"><span className="stat-label">Open now</span><span className="stat-value">{r.summary.open_now}</span></div>
          </section>

          <div className="grid-2">
            <section className="card">
              <h2>Inflow and outflow per {r.period.bucket}</h2>
              <GroupedBars
                data={r.flow}
                xLabel={(d) => bucketLabel(d.bucket)}
                series={[
                  { key: 'opened', label: 'Logged', color: 'var(--series-1)' },
                  { key: 'resolved', label: 'Resolved', color: 'var(--series-2)' },
                ]}
              />
            </section>
            <section className="card">
              <h2>Open problems</h2>
              <LineChart data={r.backlog} valueKey="open" label="open problems" xLabel={(d) => bucketLabel(d.at)} />
            </section>
          </div>

          <section className="card">
            <h2>Lead times by priority</h2>
            <p className="muted small">Time from logging to known error and to resolution, for problems reaching that stage in the period. Median and 90th percentile.</p>
            {r.lead_times.length === 0 ? <p className="empty">No problems reached known error or resolution in the period.</p> : (
              <div className="table-wrap">
                <table className="table compact numeric">
                  <thead>
                    <tr><th>Priority</th><th>Known errors</th><th>Median</th><th>90th pct</th><th>Resolved</th><th>Median</th><th>90th pct</th></tr>
                  </thead>
                  <tbody>
                    {r.lead_times.map((l) => (
                      <tr key={l.priority}>
                        <td>P{l.priority} {PRIORITY_LABEL[l.priority]}</td>
                        <td>{l.known_error_count}</td><td>{duration(l.known_error_median_h)}</td><td>{duration(l.known_error_p90_h)}</td>
                        <td>{l.resolved_count}</td><td>{duration(l.resolved_median_h)}</td><td>{duration(l.resolved_p90_h)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="grid-2">
            <section className="card">
              <h2>Services with most linked incidents</h2>
              <HBars rows={r.hotspots.services.filter((s) => s.incidents > 0).map((s) => ({ label: s.name, value: s.incidents, detail: `${s.incidents} incidents, ${s.events} events, ${s.open_problems} open problems` }))} empty="No incidents linked in the period." />
            </section>
            <section className="card">
              <h2>Logged by category</h2>
              <HBars rows={r.hotspots.categories.map((c) => ({ label: c.name, value: c.logged, detail: `${c.open} still open` }))} empty="No problems logged in the period." />
            </section>
          </div>

          {(r.hotspots.cis.length > 0 || r.hotspots.ci_types.length > 0) && (
            <div className="grid-2 wide-left">
              <section className="card flush">
                <h2 className="pad">CI hotspots</h2>
                <p className="muted small pad">Incidents and events per CI in the period. "Not linked" are records no problem explains yet: candidates for proactive problem management.</p>
                <div className="table-wrap">
                  <table className="table compact">
                    <thead><tr><th>CI</th><th>Type</th><th className="num">Records</th><th className="num">Not linked</th><th className="num">Open problems</th><th className="num">Known errors</th></tr></thead>
                    <tbody>
                      {r.hotspots.cis.map((c) => (
                        <tr key={c.ref}>
                          <td><Link to={`/cis/${c.ref}`}><span className="mono small">{c.ref}</span> {c.name}</Link></td>
                          <td className="muted">{c.type_label}</td>
                          <td className="num">{c.records}</td>
                          <td className={`num ${c.unlinked ? 'attention' : ''}`}>{c.unlinked}</td>
                          <td className="num">{c.open_problems}</td>
                          <td className="num">{c.known_errors}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="card">
                <h2>By CI type</h2>
                <HBars rows={r.hotspots.ci_types.map((t) => ({ label: t.name, value: t.records, detail: `${t.records} records, ${t.problems} problems` }))} empty="No records on CIs in the period." />
              </section>
            </div>
          )}

          <div className="grid-3">
            <section className="card">
              <h2>Known error database</h2>
              <dl className="kv">
                <dt>Known errors</dt><dd>{r.known_errors.count}</dd>
                <dt>Average age</dt><dd>{r.known_errors.avg_age_days} d</dd>
                <dt>With workaround</dt><dd>{pct(r.known_errors.with_workaround, r.known_errors.count)}</dd>
                <dt>With decision</dt><dd>{pct(r.known_errors.with_decision, r.known_errors.count)}</dd>
                <dt>Risk accepted</dt><dd>{r.known_errors.risk_accepted}</dd>
                <dt>Review overdue</dt><dd className={r.known_errors.review_due ? 'warn' : ''}>{r.known_errors.review_due}</dd>
              </dl>
            </section>
            <section className="card">
              <h2>Follow-up actions</h2>
              <dl className="kv">
                <dt>Created in period</dt><dd>{r.actions.created}</dd>
                <dt>Completed in period</dt><dd>{r.actions.completed}</dd>
                <dt>Completed on time</dt><dd>{r.actions.on_time_rate === null ? '–' : `${r.actions.on_time_rate}%`}</dd>
                <dt>Open now</dt><dd>{r.actions.open_now}</dd>
                <dt>Overdue now</dt><dd className={r.actions.overdue_now ? 'warn' : ''}>{r.actions.overdue_now}</dd>
              </dl>
            </section>
            <section className="card">
              <h2>Closures</h2>
              <HBars rows={r.closures.map((c) => ({ label: CLOSURE_LABEL[c.closure_code] ?? c.closure_code, value: c.count }))} empty="Nothing closed in the period." />
            </section>
          </div>
        </div>
      )}
    </>
  );
}
