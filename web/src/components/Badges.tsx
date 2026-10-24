import { PRIORITY_LABEL } from '../format';
import { BADGE_STATUS, type StatusKind, type StatusOf } from '../statuses';

/** The status of any record kind, coloured by kind: <StatusBadge kind="incident" status="on_hold" />. */
export function StatusBadge<K extends StatusKind>({ kind, status }: { kind: K; status: StatusOf<K> }) {
  const { prefix, labels } = BADGE_STATUS[kind];
  return <span className={`badge ${prefix}-${String(status)}`}>{(labels as Record<string, string>)[status as string]}</span>;
}

const PERSONAL_DATA_HINT = 'The text holds personal data (personal identity numbers or email addresses). It is kept, and counts for retention and AI handling.';
export function PersonalDataBadge() {
  return <span className="badge" title={PERSONAL_DATA_HINT}>Personal data</span>;
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

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`badge sev sev-${severity}`}>{severity}</span>;
}

const SLA_LABEL: Record<string, string> = { on_track: 'On track', at_risk: 'At risk', breached: 'Breached', met: 'Met', paused: 'Paused' };
export function SlaBadge({ state, title }: { state?: string | null; title?: string }) {
  if (!state || state === 'none') return null;
  return <span className={`badge sla-${state}`} title={title}>{SLA_LABEL[state] ?? state}</span>;
}
