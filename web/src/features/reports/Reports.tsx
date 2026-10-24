import { Link } from 'react-router';
import { HiddenRecordsNote } from '../../components/Visibility';
import { useState } from 'react';
import { GroupedBars, HBars, LineChart } from './components/Charts';
import { CLOSURE_LABEL, formatDay, PRIORITY_LABEL } from '../../format';
import { useApi } from '../../hooks';
import { useSession } from '../../session';
import type { ProblemReport } from '../../api/types/reports';

const pctOf = (met: number, of: number) => (of ? `${Math.round((met / of) * 100)}%` : '–');

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
  const { meta } = useSession();
  const [range, setRange] = useState<{ name: string; from: string; to: string }>(() => {
    const [from, to] = preset('90d');
    return { name: '90d', from, to };
  });
  const query = new URLSearchParams({ from: range.from, to: range.to });
  const { data: r, error, loading } = useApi<ProblemReport>(`/api/reports?${query}`);

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
          <p className="muted">{meta.modules?.problem !== false ? 'How problem management is performing: flow, lead times, quality and where problems come from.' : 'How the practices are performing: service levels, incidents and changes.'}</p>
        </div>
        <div className="head-actions no-print">
          {meta.modules?.problem !== false && <a className="btn" href={`/api/reports/problems.csv?${query}`}>Export CSV</a>}
          <button className="btn" onClick={() => window.print()}>Print</button>
        </div>
      </header>
      <HiddenRecordsNote />

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
          {/* Problem management's sections, while it is on (#184). */}
          {r.problems && (<>
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

          </>)}

          {r.sla && r.sla.overall.resolved > 0 && (
            <section className="card flush">
              <h2 className="pad">SLA compliance <span className="muted small">incidents resolved in the period</span></h2>
              <div className="table-wrap">
                <table className="table compact">
                  <thead><tr><th>Group</th><th className="num">Resolved</th><th className="num">Response met</th><th className="num">Resolution met</th></tr></thead>
                  <tbody>
                    <tr className="total"><td><strong>All</strong></td><td className="num">{r.sla.overall.resolved}</td><td className="num">{pctOf(r.sla.overall.response_met, r.sla.overall.response_with_target)}</td><td className="num">{pctOf(r.sla.overall.resolution_met, r.sla.overall.resolution_with_target)}</td></tr>
                    {r.sla.by_priority.map((p) => <tr key={`p${p.priority}`}><td>P{p.priority}</td><td className="num">{p.resolved}</td><td className="num">{pctOf(p.response_met, p.response_with_target)}</td><td className="num">{pctOf(p.resolution_met, p.resolution_with_target)}</td></tr>)}
                    {r.sla.by_service.map((s) => <tr key={`s${s.name}`}><td>{s.name}</td><td className="num">{s.resolved}</td><td className="num">{pctOf(s.response_met, s.response_with_target)}</td><td className="num">{pctOf(s.resolution_met, s.resolution_with_target)}</td></tr>)}
                    {r.sla.by_group.map((g) => <tr key={`g${g.name}`}><td className="muted">{g.name}</td><td className="num">{g.resolved}</td><td className="num">{pctOf(g.response_met, g.response_with_target)}</td><td className="num">{pctOf(g.resolution_met, g.resolution_with_target)}</td></tr>)}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {r.incidents && (r.incidents.opened > 0 || r.incidents.open_now > 0) && (
            <div className="grid-2 wide-left">
              <section className="card">
                <h2>Incidents</h2>
                <dl className="kv">
                  <dt>Opened in period</dt><dd>{r.incidents.opened}</dd>
                  <dt>Resolved in period</dt><dd>{r.incidents.resolved}</dd>
                  <dt>Open now</dt><dd>{r.incidents.open_now}</dd>
                  <dt>Major incidents</dt><dd>{r.incidents.major}</dd>
                  <dt>Median time to respond (MTTA)</dt><dd>{r.incidents.mtta_median_min === null ? '–' : `${r.incidents.mtta_median_min} min`}</dd>
                  <dt>Median time to resolve (MTTR)</dt><dd>{r.incidents.mttr_median_h === null ? '–' : `${r.incidents.mttr_median_h} h`}</dd>
                  <dt>Reopened</dt><dd className={r.incidents.reopened ? 'attention' : ''}>{r.incidents.opened ? Math.round((r.incidents.reopened / r.incidents.opened) * 100) : 0}%</dd>
                  {r.problems && <><dt>Linked to a problem</dt><dd>{r.incidents.opened ? Math.round((r.incidents.with_problem / r.incidents.opened) * 100) : 0}%</dd></>}
                  {r.incidents.reviews && r.incidents.reviews.major_resolved > 0 && (
                    <>
                      <dt>Major incidents with a published review</dt><dd className={(r.incidents.reviews.reviewed_share ?? 0) < 100 ? 'attention' : ''}>{r.incidents.reviews.reviewed_share}% <span className="muted small">({r.incidents.reviews.reviewed} of {r.incidents.reviews.major_resolved}{r.incidents.reviews.waived ? `, ${r.incidents.reviews.waived} waived` : ''})</span></dd>
                      <dt>Median time from resolve to review</dt><dd>{r.incidents.reviews.median_days_to_review === null ? '–' : `${r.incidents.reviews.median_days_to_review} days`}</dd>
                    </>
                  )}
                </dl>
              </section>
              {r.changes && (
                <section className="card">
                  <h2>Changes</h2>
                  <dl className="kv">
                    <dt>Requested in period</dt><dd>{r.changes.requested}</dd>
                    <dt>Implemented</dt><dd>{r.changes.implemented}</dd>
                    <dt>Success rate</dt><dd>{r.changes.implemented ? `${Math.round((r.changes.successful / r.changes.implemented) * 100)}%` : '–'}</dd>
                    <dt>Emergency changes</dt><dd className={r.changes.requested && r.changes.emergency / r.changes.requested > 0.2 ? 'attention' : ''}>{r.changes.requested ? Math.round((r.changes.emergency / r.changes.requested) * 100) : 0}%</dd>
                    <dt>Standard changes</dt><dd>{r.changes.requested ? Math.round((r.changes.standard / r.changes.requested) * 100) : 0}%</dd>
                    <dt>Followed by incidents (24 h)</dt><dd className={r.changes.followed_by_incidents ? 'attention' : ''}>{r.changes.followed_by_incidents}</dd>
                  </dl>
                </section>
              )}
              <section className="card">
                <h2>Incidents per CI</h2>
                <HBars rows={r.incidents.by_ci.map((c) => ({ label: c.name, value: c.incidents, detail: `${c.incidents} incidents, ${c.without_problem} without a problem` }))} empty="No incidents on CIs in the period." />
              </section>
            </div>
          )}

          {r.problems && (
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
          )}
        </div>
      )}
    </>
  );
}
