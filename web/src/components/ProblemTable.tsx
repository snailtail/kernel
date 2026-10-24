import { Link } from 'react-router';
import type { Problem } from '../api';
import { ageDays, relativeTime } from '../format';
import { MajorBadge, PriorityBadge, StatusBadge } from './Badges';
import type { ColumnKey, Toolkit } from './ListToolkit';

export const PROBLEM_COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'priority', label: 'Priority' }, { key: 'status', label: 'Status' }, { key: 'service', label: 'Service' },
  { key: 'assignee', label: 'Assignee' }, { key: 'age', label: 'Age' }, { key: 'updated', label: 'Updated' },
];

/** Problems as a table; with a toolkit (#110) the rows can be selected and triaged. */
export function ProblemTable({ problems, empty = 'No problems found.', compact, toolkit }: { problems: Problem[]; empty?: string; compact?: boolean; toolkit?: Toolkit<Problem> }) {
  if (!problems.length) return <p className="empty">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {toolkit?.selectAll && <th className="check-col">{toolkit.selectAll}</th>}
            <th>Ref</th>
            <th>Title</th>
            <th data-col="priority">Priority</th>
            <th data-col="status">Status</th>
            {!compact && <th className="hide-sm" data-col="service">Service</th>}
            {!compact && <th className="hide-sm" data-col="assignee">Assignee</th>}
            <th className="hide-sm" data-col="age">Age</th>
            {!compact && <th className="hide-sm" data-col="updated">Updated</th>}
          </tr>
        </thead>
        <tbody>
          {problems.map((p, n) => (
            <tr key={p.id} {...toolkit?.rowProps(p, n)}>
              {toolkit?.selectAll && <td className="check-col">{toolkit.select(p, n)}</td>}
              <td className="mono nowrap"><Link to={`/problems/${p.ref}`}>{p.ref}</Link></td>
              <td className="title-cell">
                <Link to={`/problems/${p.ref}`}>{p.title}</Link>
                {p.is_major && <MajorBadge />}
              </td>
              <td data-col="priority"><PriorityBadge priority={p.priority} /></td>
              <td data-col="status"><StatusBadge kind="problem" status={p.status} /></td>
              {!compact && <td className="muted hide-sm" data-col="service">{p.affected_service || '–'}</td>}
              {!compact && <td className={`hide-sm ${p.assignee ? '' : 'muted'}`} data-col="assignee">{p.assignee ?? 'Unassigned'}</td>}
              <td className="muted nowrap hide-sm" data-col="age">{ageDays(p.created_at)} d</td>
              {!compact && <td className="muted nowrap hide-sm" data-col="updated">{relativeTime(p.updated_at)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
