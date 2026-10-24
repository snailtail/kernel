// Development work (#165): what the backlog and an item's page share.
import { useState } from 'react';
import { FormModal } from '../../components/Modal';
import type { WorkItemStatus } from '../../statuses';
import type { Progress, WorkItemType } from '../../api/types/development';
import './styles.css';

export const TYPES: WorkItemType[] = ['epic', 'story', 'bug', 'task'];
export const TYPE_LABEL: Record<WorkItemType, string> = { epic: 'Epic', story: 'Story', bug: 'Bug', task: 'Task' };
/** Story points: the server's fixed scale. */
export const POINTS = [1, 2, 3, 5, 8, 13];
/** The parents each type can have, as on the server: epic → story or bug → task. */
export const PARENT_TYPES: Record<WorkItemType, WorkItemType[]> = { epic: [], story: ['epic'], bug: ['epic'], task: ['story', 'bug'] };

const TRANSITION_LABEL: Record<WorkItemStatus, string> = { new: 'Back to new', ready: 'Mark ready', in_progress: 'Start', in_review: 'To review', done: 'Mark done', removed: 'Remove' };
/** A move back says so: "Back to ready" pauses work, "Reopen" picks done work up again. */
export const transitionLabel = (from: WorkItemStatus, to: WorkItemStatus) =>
  from === 'done' && to === 'in_progress' ? 'Reopen' : from === 'removed' && to === 'new' ? 'Restore' : from === 'in_progress' && to === 'ready' ? 'Back to ready' : from === 'in_review' && to === 'in_progress' ? 'Back to in progress' : TRANSITION_LABEL[to];

export function TypeBadge({ type }: { type: WorkItemType }) {
  return <span className={`wi-type wi-type-${type}`}>{TYPE_LABEL[type]}</span>;
}

/** An epic's progress in points (items when nothing is estimated). */
export function ProgressBar({ p }: { p: Progress }) {
  const byPoints = p.points > 0;
  const [done, total] = byPoints ? [p.points_done, p.points] : [p.items_done, p.items];
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <span className="wi-progress" title={`${done} of ${total} ${byPoints ? 'points' : 'items'} done`}>
      <span className="wi-progress-bar" aria-hidden><span style={{ width: `${pct}%` }} /></span>
      <span className="muted small">{done}/{total} {byPoints ? 'pts' : 'items'}</span>
    </span>
  );
}

/**
 * Moving to ready or done with a team's definition: tick what holds. Guidance, not a gate: moving on with items
 * unticked is allowed, and the item's history says what was skipped.
 */
export function DefinitionCheck({ to, items, onClose, onConfirm }: { to: 'ready' | 'done'; items: string[]; onClose: () => void; onConfirm: (checked: string[]) => Promise<unknown> }) {
  const [checked, setChecked] = useState<string[]>([]);
  const name = to === 'ready' ? 'Definition of Ready' : 'Definition of Done';
  const missing = items.length - checked.length;
  return (
    <FormModal title={name} submitLabel={missing ? `${to === 'ready' ? 'Mark ready' : 'Mark done'} anyway` : to === 'ready' ? 'Mark ready' : 'Mark done'} onClose={onClose} onSubmit={() => onConfirm(checked)}
      intro={<p className="muted small">The team agreed on these. Tick what holds; anything left unticked is noted in the history.</p>}>
      <fieldset className="full wi-definition" aria-label={name}>
        {items.map((d) => (
          <label key={d} className="check"><input type="checkbox" checked={checked.includes(d)} onChange={(e) => setChecked(e.target.checked ? [...checked, d] : checked.filter((c) => c !== d))} /> {d}</label>
        ))}
      </fieldset>
    </FormModal>
  );
}
