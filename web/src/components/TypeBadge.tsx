// A work item's type (#165), wherever work items are listed: the backlog, the board, a change's deliveries.
import type { WorkItemType } from '../api/types/development';

export const TYPE_LABEL: Record<WorkItemType, string> = { epic: 'Epic', story: 'Story', bug: 'Bug', task: 'Task' };

export function TypeBadge({ type }: { type: WorkItemType }) {
  return <span className={`wi-type wi-type-${type}`}>{TYPE_LABEL[type]}</span>;
}
