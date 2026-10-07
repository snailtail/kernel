import { Link } from 'react-router';
import type { Problem } from '../api';
import { ageDays, relativeTime } from '../format';
import { MajorBadge, PriorityBadge, StatusBadge } from './Badges';

export function ProblemTable({ problems, empty = 'No problems found.' }: { problems: Problem[]; empty?: string }) {
  if (!problems.length) return <p className="empty">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Ref</th>
            <th>Title</th>
            <th>Priority</th>
            <th>Status</th>
            <th>Service</th>
            <th>Assignee</th>
            <th>Age</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {problems.map((p) => (
            <tr key={p.id}>
              <td className="mono"><Link to={`/problems/${p.ref}`}>{p.ref}</Link></td>
              <td className="title-cell">
                <Link to={`/problems/${p.ref}`}>{p.title}</Link>
                {p.is_major && <MajorBadge />}
              </td>
              <td><PriorityBadge priority={p.priority} /></td>
              <td><StatusBadge status={p.status} /></td>
              <td className="muted">{p.affected_service || '–'}</td>
              <td className={p.assignee ? '' : 'muted'}>{p.assignee ?? 'Unassigned'}</td>
              <td className="muted">{ageDays(p.created_at)} d</td>
              <td className="muted">{relativeTime(p.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
