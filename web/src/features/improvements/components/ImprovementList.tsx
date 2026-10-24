import { Link } from 'react-router';
import { StatusBadge } from '../../../components/Badges';
import { useListToolkit } from '../../../components/list/ListToolkit';
import { useColumns, type ColumnKey } from '../../../components/list/columns';
import { relativeTime } from '../../../format';
import type { ImprovementRow } from '../../../api/types/improvements';
import { rating, quadrantOf } from '../common';

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'status', label: 'Status' }, { key: 'priority', label: 'Value / effort' }, { key: 'assignee', label: 'Owner' }, { key: 'service', label: 'Service' }, { key: 'updated', label: 'Updated' },
];

export function ImprovementList({ rows, loading, filter, onChanged }: { rows: ImprovementRow[] | null; loading: boolean; filter: string; onChanged: () => void }) {
  const tk = useListToolkit({ list: 'improvements', rows, idOf: (m) => m.ref, hrefOf: (m) => `/improvements/${m.ref}`, filter, onChanged });
  const cols = useColumns('improvements', COLUMNS);
  return (
    <>
      <div className="filters">{cols.picker}</div>
      {tk.scope}
      <section className={`card flush ${loading ? 'is-loading' : ''}`} {...cols.container}>
        {rows?.length === 0 ? <p className="empty">No improvements match.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{tk.selectAll && <th className="check-col">{tk.selectAll}</th>}<th>Ref</th><th>Title</th><th data-col="status">Status</th><th data-col="priority">Value / effort</th><th className="hide-sm" data-col="assignee">Owner</th><th className="hide-sm" data-col="service">Service</th><th className="hide-sm" data-col="updated">Updated</th></tr></thead>
              <tbody>
                {rows?.map((m, n) => (
                  <tr key={m.ref} {...tk.rowProps(m, n)}>
                    {tk.selectAll && <td className="check-col">{tk.select(m, n)}</td>}
                    <td className="mono nowrap"><Link to={`/improvements/${m.ref}`}>{m.ref}</Link></td>
                    <td className="title-cell"><Link to={`/improvements/${m.ref}`}>{m.title}</Link>{quadrantOf(m) === 'quick' && <span className="tag quick-win">quick win</span>}</td>
                    <td data-col="status"><StatusBadge kind="improvement" status={m.status} /></td>
                    <td className="nowrap" data-col="priority">{rating(m)}</td>
                    <td className="hide-sm" data-col="assignee">{m.owner ?? <span className="muted">–</span>}</td>
                    <td className="hide-sm small" data-col="service">{m.service_name ?? '–'}</td>
                    <td className="hide-sm small nowrap" data-col="updated">{relativeTime(m.updated_at)}</td>
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
