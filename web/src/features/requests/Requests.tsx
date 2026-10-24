// Service requests (#44), an optional module: the list, the page of one request (its answers, approval and tasks in
// order) and the "new request" flow with the item's form generated from the catalogue.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { StatusBadge } from '../../components/Badges';
import { useListToolkit } from '../../components/list/ListToolkit';
import { useColumns, type ColumnKey } from '../../components/list/columns';
import { SavedViews } from '../../components/SavedViews';
import { relativeTime } from '../../format';
import { useApi, useListParams, useSearchText } from '../../hooks';
import { useLive } from '../../hooks/useLive';
import { canEdit, useSession } from '../../session';
import { REQUEST_STATUS, type RequestStatus } from '../../statuses';
import type { RequestRow } from '../../api/types/requests';
import { NewRequest } from './components/NewRequest';

const STATUSES = Object.keys(REQUEST_STATUS) as RequestStatus[];

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'status', label: 'Status' }, { key: 'assignee', label: 'Open task' }, { key: 'service', label: 'Item' }, { key: 'updated', label: 'Updated' },
];

export function RequestsPage() {
  const { user } = useSession();
  const navigate = useNavigate();
  const { params, setParams, set } = useListParams();
  const [q, setQ] = useSearchText();
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setCreating(true);
    const next = new URLSearchParams(params);
    next.delete('new');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  const query = new URLSearchParams([...params].filter(([k]) => k !== 'new'));
  const { data, loading, refresh } = useApi<RequestRow[]>(`/api/requests?${query}`);
  useLive(['request:*'], refresh);
  const tk = useListToolkit({ list: 'requests', rows: data, idOf: (r) => r.ref, hrefOf: (r) => `/requests/${r.ref}`, filter: query.toString(), onChanged: refresh });
  const cols = useColumns('requests', COLUMNS);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Service requests</h1>
          <p className="muted">Accounts, access, new VMs: approved when needed, then fulfilled task by task. Never counted as incidents.</p>
        </div>
        <SavedViews list="requests" />
        {canEdit(user) && <button className="btn primary page-new" onClick={() => setCreating(true)}>New request</button>}
      </header>
      <div className="filters">
        <input className="search" placeholder="Search requests…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={params.get('status') ?? 'open'} onChange={(e) => set('status', e.target.value === 'open' ? '' : e.target.value)} aria-label="Status">
          <option value="open">Open</option>{STATUSES.map((s) => <option key={s} value={s}>{REQUEST_STATUS[s]}</option>)}<option value="all">All</option>
        </select>
        <select value={params.get('task') ?? ''} onChange={(e) => set('task', e.target.value)} aria-label="Task">
          <option value="">Any task</option><option value="mine">My tasks</option><option value="my_teams">My teams' tasks</option>
        </select>
        <label className="check"><input type="checkbox" checked={params.get('awaiting_me') === 'true'} onChange={(e) => set('awaiting_me', e.target.checked ? 'true' : '')} /> Waiting for my approval</label>
        {cols.picker}
      </div>
      {tk.scope}
      <section className={`card flush ${loading ? 'is-loading' : ''}`} {...cols.container}>
        {data?.length === 0 ? <p className="empty">No requests match.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{tk.selectAll && <th className="check-col">{tk.selectAll}</th>}<th>Ref</th><th>Title</th><th data-col="status">Status</th><th className="hide-sm" data-col="assignee">Open task</th><th className="hide-sm" data-col="service">Item</th><th className="hide-sm" data-col="updated">Updated</th></tr></thead>
              <tbody>
                {data?.map((r, n) => (
                  <tr key={r.ref} {...tk.rowProps(r, n)}>
                    {tk.selectAll && <td className="check-col">{tk.select(r, n)}</td>}
                    <td className="mono nowrap"><Link to={`/requests/${r.ref}`}>{r.ref}</Link></td>
                    <td className="title-cell"><Link to={`/requests/${r.ref}`}>{r.title}</Link>{r.at_risk && <span className="badge overdue">SLA</span>}<div className="muted small">for {r.requester}</div></td>
                    <td data-col="status"><StatusBadge kind="request" status={r.status} /></td>
                    <td className="hide-sm small" data-col="assignee">{r.open_task ? <>{r.open_task}<div className="muted">{r.open_task_assignee ?? r.open_task_team ?? 'Anyone'}</div></> : '–'}</td>
                    <td className="hide-sm small" data-col="service">{r.item}<div className="muted">{r.service_name}</div></td>
                    <td className="hide-sm small nowrap" data-col="updated">{relativeTime(r.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {tk.bar}
      {creating && <NewRequest onClose={() => setCreating(false)} onDone={(ref) => navigate(`/requests/${ref}`)} />}
    </>
  );
}
