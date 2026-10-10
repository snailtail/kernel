import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { PriorityBadge } from '../components/Badges';
import { formatDate } from '../format';
import { useApi } from '../hooks';

interface Report {
  service: { ref: string; name: string; criticality: number; sla: string | null };
  period: { from: string; to: string; minutes: number };
  availability: { percent: number | null; target: number | null; outage_minutes: number; degraded_minutes: number; maintenance_minutes: number; basis: string };
  incidents: { total: number; by_priority: { priority: number; count: number }[]; resolution_sla: { met: number; of: number; percent: number } | null; mttr_minutes: number | null; linked_to_problems: number; major: { ref: string; title: string; created_at: string; resolved_at: string | null }[] };
  changes: { total: number; completed: number; successful: number; success_rate: number | null; failed: { ref: string; title: string; outcome: string }[] };
  problems: { ref: string; title: string; status: string; priority: number; workaround: string | null }[];
  restricted_records_left_out: boolean;
}

const dur = (m: number | null) => (m === null ? '–' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`);

/** One service, one period: the basis for the service review (#54). Print it, or download Markdown. */
export function ServiceReportPage() {
  const { ref } = useParams();
  const [params, setParams] = useSearchParams();
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const { data: r, error } = useApi<Report>(`/api/services/${ref}/report?${params}`);
  if (error) return <div className="error">{error}</div>;
  if (!r) return null;
  const missed = r.availability.target != null && r.availability.percent != null && r.availability.percent < r.availability.target;
  return (
    <div className="service-report">
      <header className="page-head">
        <div>
          <div className="crumbs no-print"><Link to={`/cis/${r.service.ref}`}>{r.service.name}</Link> / report</div>
          <h1>Service report: {r.service.name}</h1>
          <p className="muted">{r.period.from} – {r.period.to}{r.service.sla ? ` · SLA ${r.service.sla}` : ''}</p>
        </div>
        <div className="head-actions no-print">
          <form className="period-form" onSubmit={(e) => { e.preventDefault(); setParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }); }}>
            <input type="date" value={from || r.period.from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <input type="date" value={to || r.period.to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
            <button className="btn">Show</button>
          </form>
          <a className="btn" href={`/api/services/${r.service.ref}/report.md?${params}`}>Markdown</a>
          <button className="btn" onClick={() => window.print()}>Print</button>
        </div>
      </header>
      {r.restricted_records_left_out && <p className="muted small">🔒 Some restricted records are not included.</p>}
      <div className="kpi-row">
        <div className={`kpi card ${missed ? 'kpi-bad' : ''}`}><div className="kpi-value">{r.availability.percent ?? '–'} %</div><div className="kpi-label">Availability{r.availability.target != null ? ` (target ${r.availability.target} %)` : ''}</div></div>
        <div className="kpi card"><div className="kpi-value">{dur(r.availability.outage_minutes)}</div><div className="kpi-label">Outage</div></div>
        <div className="kpi card"><div className="kpi-value">{r.incidents.total}</div><div className="kpi-label">Incidents</div></div>
        <div className="kpi card"><div className="kpi-value">{r.incidents.resolution_sla ? `${r.incidents.resolution_sla.percent} %` : '–'}</div><div className="kpi-label">Resolved within SLA</div></div>
        <div className="kpi card"><div className="kpi-value">{dur(r.incidents.mttr_minutes)}</div><div className="kpi-label">MTTR</div></div>
        <div className="kpi card"><div className="kpi-value">{r.changes.success_rate ?? '–'}{r.changes.success_rate != null ? ' %' : ''}</div><div className="kpi-label">Change success</div></div>
      </div>
      <p className="muted small">{r.availability.basis} Degraded: {dur(r.availability.degraded_minutes)}. Planned maintenance: {dur(r.availability.maintenance_minutes)}.</p>
      <div className="grid-2">
        <section className="card">
          <h2>Incidents</h2>
          <p>{r.incidents.by_priority.map((p) => `P${p.priority}: ${p.count}`).join(' · ') || 'None.'} {r.incidents.linked_to_problems ? `· ${r.incidents.linked_to_problems} linked to problems` : ''}</p>
          {r.incidents.major.length > 0 && (
            <ul className="plain-list">{r.incidents.major.map((i) => <li key={i.ref}><Link to={`/incidents/${i.ref}`} className="mono small">{i.ref}</Link> {i.title} <span className="muted small">{formatDate(i.created_at)} – {i.resolved_at ? formatDate(i.resolved_at) : 'open'}</span></li>)}</ul>
          )}
        </section>
        <section className="card">
          <h2>Changes</h2>
          <p>{r.changes.total} changes · {r.changes.completed} completed · {r.changes.successful} successful</p>
          {r.changes.failed.length > 0 && <ul className="plain-list">{r.changes.failed.map((c) => <li key={c.ref}><Link to={`/changes/${c.ref}`} className="mono small">{c.ref}</Link> {c.title} <span className="badge">{c.outcome.replace('_', ' ')}</span></li>)}</ul>}
        </section>
      </div>
      <section className="card">
        <h2>Open problems and known errors</h2>
        {r.problems.length === 0 ? <p className="placeholder">None.</p> : (
          <ul className="plain-list">
            {r.problems.map((p) => (
              <li key={p.ref}><Link to={`/problems/${p.ref}`} className="mono small">{p.ref}</Link> {p.title} <PriorityBadge priority={p.priority} /> <span className="muted small">{p.status.replace('_', ' ')}</span>
                {p.workaround && <div className="muted small">Workaround: {p.workaround.split('\n')[0]}</div>}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
