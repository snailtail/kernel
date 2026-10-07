import type { Status } from '../api';
import { PRIORITY_LABEL, STATUS_LABEL } from '../format';

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function PriorityBadge({ priority }: { priority: number }) {
  return (
    <span className={`badge prio prio-${priority}`} title={`Priority ${priority}`}>
      P{priority} · {PRIORITY_LABEL[priority]}
    </span>
  );
}

export function MajorBadge() {
  return <span className="badge major">Major</span>;
}
