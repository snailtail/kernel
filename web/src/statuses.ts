import type { Status } from './api/client';

/** The status labels of every record kind, in lifecycle order; the server holds the transitions. */

export const PROBLEM_STATUS: Record<Status, string> = {
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

export type IncidentStatus = 'new' | 'in_progress' | 'on_hold' | 'resolved' | 'closed';
export const INCIDENT_STATUS: Record<IncidentStatus, string> = { new: 'New', in_progress: 'In progress', on_hold: 'On hold', resolved: 'Resolved', closed: 'Closed' };
export const INCIDENT_RESOLUTION: Record<string, string> = {
  fixed: 'Fixed', workaround: 'Workaround applied', problem_fixed: 'Fixed by problem resolution', no_fault_found: 'No fault found', duplicate: 'Duplicate', cancelled: 'Cancelled',
};

export type ChangeStatus = 'draft' | 'assess' | 'authorize' | 'scheduled' | 'implementing' | 'review' | 'closed' | 'rejected' | 'cancelled';
export const CHANGE_STATUS: Record<ChangeStatus, string> = {
  draft: 'Draft', assess: 'Assess', authorize: 'Authorise', scheduled: 'Scheduled', implementing: 'Implementing', review: 'Review', closed: 'Closed', rejected: 'Rejected', cancelled: 'Cancelled',
};

export type RequestStatus = 'submitted' | 'awaiting_approval' | 'in_fulfilment' | 'fulfilled' | 'rejected' | 'cancelled';
export const REQUEST_STATUS: Record<RequestStatus, string> = {
  submitted: 'Submitted', awaiting_approval: 'Awaiting approval', in_fulfilment: 'In fulfilment', fulfilled: 'Fulfilled', rejected: 'Rejected', cancelled: 'Cancelled',
};

export type ImprovementStatus = 'idea' | 'approved' | 'in_progress' | 'done' | 'rejected';
export const IMPROVEMENT_STATUS: Record<ImprovementStatus, string> = { idea: 'Idea', approved: 'Approved', in_progress: 'In progress', done: 'Done', rejected: 'Rejected' };

export type ReviewStatus = 'scheduled' | 'draft' | 'published' | 'waived';
const REVIEW_STATUS: Record<ReviewStatus, string> = { scheduled: 'Scheduled', draft: 'Draft', published: 'Published', waived: 'Waived' };

export const ACTION_STATUS = { open: 'Open', done: 'Done', cancelled: 'Cancelled' };
export const ARTICLE_STATUS = { draft: 'Draft', published: 'Published', retired: 'Retired' };
export const CI_STATUS = { planned: 'Planned', active: 'Active', maintenance: 'Maintenance', retired: 'Retired', missing: 'Missing' };

/** The kinds <StatusBadge> shows, with the CSS class prefix each one's colours use. */
export const BADGE_STATUS = {
  problem: { prefix: 'status', labels: PROBLEM_STATUS },
  incident: { prefix: 'inc', labels: INCIDENT_STATUS },
  change: { prefix: 'chg', labels: CHANGE_STATUS },
  request: { prefix: 'req', labels: REQUEST_STATUS },
  improvement: { prefix: 'imp', labels: IMPROVEMENT_STATUS },
  review: { prefix: 'review', labels: REVIEW_STATUS },
};
export type StatusKind = keyof typeof BADGE_STATUS;
export type StatusOf<K extends StatusKind> = keyof (typeof BADGE_STATUS)[K]['labels'];
