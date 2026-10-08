import { Link } from 'react-router';
import type { Problem } from '../api';
import { ageDays, relativeTime } from '../format';
import { MajorBadge, PriorityBadge, StatusBadge } from './Badges';

export function ProblemTable({ problems, empty = 'No problems found.', compact }: { problems: Problem[]; empty?: string; compact?: boolean }) {
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
            {!compact && <th className="hide-sm">Service</th>}
            {!compact && <th className="hide-sm">Assignee</th>}
            <th className="hide-sm">Age</th>
            {!compact && <th className="hide-sm">Updated</th>}
          </tr>
        </thead>
        <tbody>
          {problems.map((p) => (
            <tr key={p.id}>
              <td className="mono nowrap"><Link to={`/problems/${p.ref}`}>{p.ref}</Link></td>
              <td className="title-cell">
                <Link to={`/problems/${p.ref}`}>{p.title}</Link>
                {p.is_major && <MajorBadge />}
              </td>
              <td><PriorityBadge priority={p.priority} /></td>
              <td><StatusBadge status={p.status} /></td>
              {!compact && <td className="muted hide-sm">{p.affected_service || '–'}</td>}
              {!compact && <td className={`hide-sm ${p.assignee ? '' : 'muted'}`}>{p.assignee ?? 'Unassigned'}</td>}
              <td className="muted nowrap hide-sm">{ageDays(p.created_at)} d</td>
              {!compact && <td className="muted nowrap hide-sm">{relativeTime(p.updated_at)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
