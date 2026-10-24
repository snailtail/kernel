import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useListToolkit } from '../../components/list/ListToolkit';
import { useColumns, type ColumnKey } from '../../components/list/columns';
import { SavedViews } from '../../components/SavedViews';
import { InboundReview } from './components/InboundReview';
import { INCIDENT_STATUS } from '../../statuses';
import { useTeams } from '../../components/Teams';
import { MajorBadge, PriorityBadge, StatusBadge } from '../../components/Badges';
import { formatDate, relativeTime } from '../../format';
import { useLive } from '../../hooks/useLive';
import { useApi, useListParams, useOpenOnNew, useSearchText } from '../../hooks';
import { useSession } from '../../session';
import { SlaBadge } from '../../components/Badges';
import type { IncidentRow } from '../../api/types/incidents';
import { NewIncident } from './components/NewIncident';

const INCIDENT_COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'status', label: 'Status' }, { key: 'priority', label: 'Priority' }, { key: 'sla', label: 'SLA' }, { key: 'cis', label: 'CIs' },
  { key: 'assignee', label: 'Assignee' }, { key: 'problem', label: 'Problem' }, { key: 'opened', label: 'Opened' },
];

export function IncidentsPage() {
  const teams = useTeams();
  const { user } = useSession();
  const { params, set } = useListParams();
  const [q, setQ] = useSearchText();
  const [creating, setCreating] = useState(false);
  useOpenOnNew(() => setCreating(true));
  const navigate = useNavigate();
  const { data, loading, refresh } = useApi<IncidentRow[]>(`/api/incidents?${params}`);
  useLive(['incident:*'], refresh);
  const tk = useListToolkit({ list: 'incidents', rows: data, idOf: (i) => i.ref, hrefOf: (i) => `/incidents/${i.ref}`, filter: params.toString(), onChanged: refresh });
  const cols = useColumns('incidents', INCIDENT_COLUMNS);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Incidents</h1>
          <p className="muted">Restore service first; hand recurring and major incidents to problem management.</p>
        </div>
        <SavedViews list="incidents" />
        {user.role !== 'viewer' && <button className="btn primary page-new" onClick={() => setCreating(true)}>New incident</button>}
      </header>
      <div className="filters">
        <input className="search" placeholder="Search incidents…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={params.get('status') ?? 'open'} onChange={(e) => set('status', e.target.value === 'open' ? '' : e.target.value)}>
          <option value="open">Open</option>
          {Object.entries(INCIDENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          <option value="all">All</option>
        </select>
        <select value={params.get('assignee') ?? ''} onChange={(e) => set('assignee', e.target.value)}>
          <option value="">Anyone</option><option value="me">Assigned to me</option><option value="none">Unassigned</option>
        </select>
        {teams.length > 0 && (
          <select value={params.get('team') ?? ''} onChange={(e) => set('team', e.target.value)} aria-label="Team">
            <option value="">Any team</option><option value="mine">My teams</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <label className="check"><input type="checkbox" checked={params.get('major') === 'true'} onChange={(e) => set('major', e.target.checked ? 'true' : '')} /> Major only</label>
        {cols.picker}
      </div>
      {user.role !== 'viewer' && <InboundReview />}
      {tk.scope}
      <section className={`card flush ${loading ? 'is-loading' : ''}`} {...cols.container}>
        {data?.length === 0 ? <p className="empty">No incidents match.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{tk.selectAll && <th className="check-col">{tk.selectAll}</th>}<th>Ref</th><th>Title</th><th data-col="status">Status</th><th data-col="priority">Priority</th><th data-col="sla">SLA</th><th className="hide-sm" data-col="cis">CIs</th><th className="hide-sm" data-col="assignee">Assignee</th><th className="hide-sm" data-col="problem">Problem</th><th className="hide-sm" data-col="opened">Opened</th></tr></thead>
              <tbody>
                {data?.map((i, n) => (
                  <tr key={i.id} {...tk.rowProps(i, n)}>
                    {tk.selectAll && <td className="check-col">{tk.select(i, n)}</td>}
                    <td className="mono nowrap"><Link to={`/incidents/${i.ref}`}>{i.ref}</Link></td>
                    <td className="title-cell">
                      <Link to={`/incidents/${i.ref}`}>{i.title}</Link> {i.is_major && <MajorBadge />}
                      {i.update_overdue && <span className="badge overdue" title="A stakeholder update is overdue">Update overdue</span>}
                      {i.parent_ref && <div className="muted small">part of <Link to={`/incidents/${i.parent_ref}`} className="mono">{i.parent_ref}</Link></div>}
                      {!!i.child_count && <div className="muted small">{i.child_count} related</div>}
                    </td>
                    <td data-col="status"><StatusBadge kind="incident" status={i.status} /></td>
                    <td data-col="priority"><PriorityBadge priority={i.priority} /></td>
                    <td className="nowrap" data-col="sla"><SlaBadge state={i.sla_state} />{i.resolution_due_at && ['on_track', 'at_risk'].includes(i.sla_state ?? '') && <div className="muted small">due {relativeTime(i.resolution_due_at)}</div>}</td>
                    <td className="hide-sm small" data-col="cis">{i.cis?.join(', ') ?? '–'}</td>
                    <td className="hide-sm muted" data-col="assignee">{i.assignee ?? (i.assignment_group || '–')}</td>
                    <td className="hide-sm mono small" data-col="problem">{i.problem_ref ? <Link to={`/problems/${i.problem_ref}`}>{i.problem_ref}</Link> : '–'}</td>
                    <td className="hide-sm muted nowrap" data-col="opened" title={formatDate(i.created_at)}>{relativeTime(i.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {tk.bar}
      {creating && <NewIncident onClose={() => setCreating(false)} onDone={(ref) => navigate(`/incidents/${ref}`)} />}
    </>
  );
}
