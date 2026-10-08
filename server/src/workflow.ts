// Problem lifecycle modelled on the ITIL 4 problem management practice:
//   Problem identification -> Problem control -> Error control -> resolved -> closed

export const STATUSES = ['new', 'analysis', 'known_error', 'resolved', 'closed'] as const;
export type Status = (typeof STATUSES)[number];

export const ROLES = ['admin', 'problem_manager', 'analyst', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const EC_DECISIONS = ['pending', 'fix', 'accept', 'defer'] as const;
export const WORKAROUND_EFFECTIVENESS = ['effective', 'partial', 'ineffective'] as const;

export const CLOSURE_CODES = ['resolved', 'workaround_accepted', 'duplicate', 'cancelled', 'no_fix'] as const;
export type ClosureCode = (typeof CLOSURE_CODES)[number];

export const TRANSITIONS: Record<Status, Status[]> = {
  new: ['analysis', 'closed'],
  analysis: ['known_error', 'resolved', 'closed'],
  known_error: ['analysis', 'resolved', 'closed'],
  resolved: ['closed', 'analysis'],
  closed: ['analysis'],
};

/** Impact and urgency are 1 (high) to 3 (low); priority 1 (critical) to 5 (planning). */
export function priorityOf(impact: number, urgency: number): number {
  return impact + urgency - 1;
}

export function canEdit(role: Role) {
  return role !== 'viewer';
}

export function isManager(role: Role) {
  return role === 'admin' || role === 'problem_manager';
}

export interface TransitionSubject {
  status: Status;
  is_major: boolean;
  root_cause: string;
  resolution: string;
  closure_code: ClosureCode | null;
  major_review: string;
  ec_decision?: string | null;
}

/** Returns a reason the transition is not allowed, or null if it is. */
export function checkTransition(p: TransitionSubject, to: Status, role: Role): string | null {
  if (!canEdit(role)) return 'Your role cannot change problems';
  if (!TRANSITIONS[p.status].includes(to)) return `Cannot move from ${p.status} to ${to}`;
  if (p.status === 'closed' && !isManager(role)) return 'Only a problem manager can reopen a closed problem';

  switch (to) {
    case 'known_error':
      if (!p.root_cause.trim()) return 'Document the root cause before raising a known error';
      break;
    case 'resolved':
      if (!p.resolution.trim()) return 'Document the resolution before resolving';
      break;
    case 'closed': {
      if (!isManager(role)) return 'Only a problem manager can close problems';
      if (!p.closure_code) return 'A closure code is required';
      const dismissed = p.closure_code === 'duplicate' || p.closure_code === 'cancelled';
      if (p.is_major && !dismissed && !p.major_review.trim()) {
        return 'A major problem review is required before closing a major problem';
      }
      if (p.closure_code === 'no_fix' && p.ec_decision !== 'accept') {
        return 'Closing without a fix requires a recorded decision to accept the risk (error control assessment)';
      }
      break;
    }
  }
  return null;
}
