import type { LinkKind, Role, Status } from './api';

export const STATUS_LABEL: Record<Status, string> = {
  new: 'New',
  analysis: 'Under Analysis',
  known_error: 'Known Error',
  resolved: 'Resolved',
  closed: 'Closed',
};

// ITIL 4 problem management phases
export const STATUS_PHASE: Record<Status, string> = {
  new: 'Problem identification',
  analysis: 'Problem control',
  known_error: 'Error control',
  resolved: 'Permanent fix in place',
  closed: 'Record closed',
};

/** The natural next step from each status; other transitions are shown as secondary. */
export const NEXT_STATUS: Partial<Record<Status, Status>> = {
  new: 'analysis',
  analysis: 'known_error',
  known_error: 'resolved',
  resolved: 'closed',
};

export const TRANSITION_LABEL: Record<Status, string> = {
  new: 'New',
  analysis: 'Start analysis',
  known_error: 'Raise known error',
  resolved: 'Resolve',
  closed: 'Close',
};

export const PRIORITY_LABEL: Record<number, string> = {
  1: 'Critical',
  2: 'High',
  3: 'Medium',
  4: 'Low',
  5: 'Planning',
};

export const LEVEL_LABEL: Record<number, string> = { 1: 'High', 2: 'Medium', 3: 'Low' };

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrator',
  manager: 'Manager',
  analyst: 'Analyst',
  viewer: 'Viewer',
  integration: 'Integration (API only)',
};

export const LINK_LABEL: Record<LinkKind, string> = {
  incident: 'Incident',
  event: 'Event',
  change: 'Change',
  problem: 'Problem',
};

export const CLOSURE_LABEL: Record<string, string> = {
  resolved: 'Resolved – permanent fix',
  workaround_accepted: 'Workaround accepted',
  duplicate: 'Duplicate',
  cancelled: 'Cancelled',
  no_fix: 'No fix – risk accepted',
};

export const FIELD_LABEL: Record<string, string> = {
  title: 'title',
  description: 'description',
  category_id: 'category',
  affected_service: 'affected service',
  detection: 'detection',
  impact: 'impact',
  urgency: 'urgency',
  is_major: 'major flag',
  assignee_id: 'assignee',
  root_cause: 'root cause',
  workaround: 'workaround',
  resolution: 'resolution',
  major_review: 'major problem review',
};

export function formatDate(value: string | null | undefined) {
  if (!value) return '–';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function relativeTime(value: string) {
  const diff = (Date.now() - new Date(value).getTime()) / 1000;
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [86400 * 30, 'day'],
    [86400 * 365, 'month'],
    [Infinity, 'year'],
  ];
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  let prev = 1;
  // The unit follows the size of the difference, past or future ("2 hours ago", "in 2 hours").
  for (const [limit, unit] of units) {
    if (Math.abs(diff) < limit) return fmt.format(-Math.round(diff / prev), unit);
    prev = limit;
  }
  return value;
}

export function ageDays(value: string) {
  return Math.floor((Date.now() - new Date(value).getTime()) / 86400000);
}

export function formatDay(value: string | null | undefined) {
  if (!value) return '–';
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** Days until a YYYY-MM-DD date (negative when past). */
export function daysUntil(value: string) {
  const [y, m, d] = value.split('-').map(Number);
  const today = new Date();
  return Math.round((new Date(y, m - 1, d).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400000);
}

export const DECISION_LABEL: Record<string, string> = {
  pending: 'Decision pending',
  fix: 'Fix permanently',
  accept: 'Risk accepted',
  defer: 'Deferred',
};

export const EFFECTIVENESS_LABEL: Record<string, string> = {
  effective: 'Workaround effective',
  partial: 'Workaround partly effective',
  ineffective: 'Workaround ineffective',
};

export const RISK_LABEL: Record<number, string> = { 1: 'High risk', 2: 'Medium risk', 3: 'Low risk' };

/** A duration in minutes as minutes, hours or days. */
export const duration = (min?: number | null) => {
  if (min === undefined || min === null) return '–';
  if (min < 60) return `${min} min`;
  if (min < 1440) return `${+(min / 60).toFixed(1)} h`;
  return `${+(min / 1440).toFixed(1)} d`;
};
