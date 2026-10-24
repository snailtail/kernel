import { Link } from 'react-router';
import { StatusBadge } from '../../../components/Badges';
import { useListToolkit } from '../../../components/list/ListToolkit';
import { useColumns, type ColumnKey } from '../../../components/list/columns';
import { useLive } from '../../../hooks/useLive';
import { useApi } from '../../../hooks';
import { useSession } from '../../../session';
import { CHANGE_STATUS } from '../../../statuses';
import type { ChangeRow } from '../../../api/types/changes';
import { OUTCOME, fmtWindow } from '../common';

const CHANGE_COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'risk', label: 'Risk' }, { key: 'window', label: 'Window' }, { key: 'cis', label: 'CIs' },
];

export function ChangeList({ params, set }: { params: URLSearchParams; set: (k: string, v: string) => void }) {
  const query = new URLSearchParams([...params].filter(([k]) => k !== 'tab'));
  const { data, loading, refresh } = useApi<ChangeRow[]>(`/api/changes?${query}`);
  useLive(['change:*'], refresh);
  const { user } = useSession();
  const tk = useListToolkit({ list: 'changes', rows: data, idOf: (c) => c.ref, hrefOf: (c) => `/changes/${c.ref}`, filter: query.toString(), onChanged: refresh });
  const cols = useColumns('changes', CHANGE_COLUMNS);
  return (
    <>
      <div className="filters">
        <select value={params.get('status') ?? 'open'} onChange={(e) => set('status', e.target.value === 'open' ? '' : e.target.value)}>
          <option value="open">Open</option>{Object.entries(CHANGE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}<option value="all">All</option>
        </select>
        <select value={params.get('type') ?? ''} onChange={(e) => set('type', e.target.value)}><option value="">Any type</option><option value="standard">Standard</option><option value="normal">Normal</option><option value="emergency">Emergency</option></select>
        {(user.role === 'admin' || user.role === 'manager') && <label className="check"><input type="checkbox" checked={params.get('awaiting_my_vote') === 'true'} onChange={(e) => set('awaiting_my_vote', e.target.checked ? 'true' : '')} /> Awaiting my approval</label>}
        {cols.picker}
      </div>
      {tk.scope}
      <section className={`card flush ${loading ? 'is-loading' : ''}`} {...cols.container}>
        {data?.length === 0 ? <p className="empty">No changes match.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{tk.selectAll && <th className="check-col">{tk.selectAll}</th>}<th>Ref</th><th>Title</th><th data-col="type">Type</th><th data-col="status">Status</th><th className="hide-sm" data-col="risk">Risk</th><th className="hide-sm" data-col="window">Window</th><th className="hide-sm" data-col="cis">CIs</th></tr></thead>
              <tbody>
                {data?.map((c, n) => (
                  <tr key={c.id} {...tk.rowProps(c, n)}>
                    {tk.selectAll && <td className="check-col">{tk.select(c, n)}</td>}
                    <td className="mono nowrap"><Link to={`/changes/${c.ref}`}>{c.ref}</Link></td>
                    <td className="title-cell"><Link to={`/changes/${c.ref}`}>{c.title}</Link>{c.source === 'pipeline' && <span className="tag">pipeline</span>}</td>
                    <td data-col="type"><span className={`tag type-${c.change_type}`}>{c.change_type}</span></td>
                    <td data-col="status"><StatusBadge kind="change" status={c.status} />{c.outcome && <div className="muted small">{OUTCOME[c.outcome]}</div>}</td>
                    <td className="hide-sm" data-col="risk">{c.risk ?? <span className="muted">assessed</span>}</td>
                    <td className="hide-sm small nowrap" data-col="window">{fmtWindow(c.planned_start, c.planned_end)}</td>
                    <td className="hide-sm small" data-col="cis">{c.cis?.join(', ') ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {tk.bar}
    </>
  );
}
