export type Role = 'admin' | 'problem_manager' | 'analyst' | 'viewer' | 'integration';
export type Status = 'new' | 'analysis' | 'known_error' | 'resolved' | 'closed';
export type LinkKind = 'incident' | 'event' | 'change' | 'problem';

export interface User {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: Role;
  preferences: Preferences;
  must_change_password?: boolean;
  mfa_enabled?: boolean;
  mfa_enrollment_required?: boolean;
}

export interface Preferences {
  theme?: 'system' | 'light' | 'dark';
  guided?: boolean;
  intro_seen?: boolean;
  saved_views?: { name: string; page: 'problems' | 'actions'; query: string }[];
}

export interface Guidance {
  phase: string;
  purpose: string;
  steps: { id: string; label: string; hint: string; done: boolean | null }[];
  next: string;
}

export interface Problem {
  id: number;
  ref: string;
  title: string;
  description: string;
  status: Status;
  category_id: number | null;
  category: string | null;
  affected_service: string;
  detection: 'reactive' | 'proactive';
  impact: number;
  urgency: number;
  priority: number;
  is_major: boolean;
  assignee_id: number | null;
  assignee: string | null;
  created_by_name: string;
  root_cause: string;
  workaround: string;
  resolution: string;
  closure_code: string | null;
  major_review: string;
  known_error_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  ec_risk_level: number | null;
  ec_risk: string;
  ec_fix_cost: string;
  ec_decision: EcDecision | null;
  ec_decision_note: string;
  ec_decided_by_name: string | null;
  ec_decided_at: string | null;
  ec_review_date: string | null;
  ec_review_due: boolean;
  workaround_effectiveness: Effectiveness | null;
  workaround_reviewed_at: string | null;
  /** Text fields written through MCP and not yet confirmed by a person. */
  mcp_proposed: string[];
}

export type EcDecision = 'pending' | 'fix' | 'accept' | 'defer';
export type Effectiveness = 'effective' | 'partial' | 'ineffective';

export interface Link {
  id: number;
  kind: LinkKind;
  reference: string;
  system: string;
  url: string;
  note: string;
  created_at: string;
  created_by: string;
}

export interface Activity {
  id: number;
  kind: 'created' | 'comment' | 'status' | 'update' | 'link' | 'action' | 'analysis' | 'assessment';
  body: string;
  data: any;
  created_at: string;
  user_name: string | null;
  channel?: string;
  ref?: string;
  title?: string;
}

export type ActionStatus = 'open' | 'done' | 'cancelled';

export interface Action {
  id: number;
  problem_id: number;
  ref: string;
  problem_title: string;
  title: string;
  description: string;
  owner_id: number | null;
  owner: string | null;
  due_date: string | null;
  status: ActionStatus;
  change_ref: string;
  overdue: boolean;
  created_by: string;
  created_at: string;
  completed_at: string | null;
}

export type Technique = 'five_whys' | 'ishikawa' | 'kepner_tregoe' | 'timeline';

export interface Analysis {
  id: number;
  technique: Technique;
  title: string;
  data: any;
  conclusion: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
  proposed_via_mcp?: boolean;
  confirmed_by?: string | null;
  confirmed_at?: string | null;
}

export interface ProblemDetail extends Problem {
  affected_cis: import('./components/AffectedCis').AffectedCi[];
  affected_services: import('./components/AffectedCis').AffectedService[];
  impact_hint: import('./components/AffectedCis').ImpactHint | null;
  impact_incomplete: boolean;
  incidents: { ref: string; title: string; status: string; priority: number; created_at: string }[];
  links: Link[];
  activity: Activity[];
  actions: Action[];
  analyses: Analysis[];
  next_steps: Guidance;
  watchers: { id: number; display_name: string }[];
  pending_approvals: { id: number; kind: string; summary: string; payload: Record<string, unknown>; human_confirmation: string; created_at: string; requested_by: string; requested_via: string; changed_since_request: boolean }[];
}

export interface Meta {
  statuses: Status[];
  transitions: Record<Status, Status[]>;
  closure_codes: string[];
  roles: Role[];
  link_kinds: LinkKind[];
  mcp_url: string | null;
  action_statuses: ActionStatus[];
  ec_decisions: EcDecision[];
  workaround_effectiveness: Effectiveness[];
  categories: { id: number; name: string; active: boolean }[];
  assignees: { id: number; display_name: string; role: Role }[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The full error body, e.g. { conflicts, changed_by, changed_at } for 409 conflicts. */
    public details: Record<string, any> = {},
  ) {
    super(message);
  }
}

export interface Conflict {
  conflicts?: { field: string; current: unknown }[];
  current?: any;
  changed_by: string | null;
  changed_at: string | null;
}

export const asConflict = (err: unknown): Conflict | null =>
  err instanceof ApiError && err.status === 409 && ('conflicts' in err.details || 'current' in err.details) ? (err.details as Conflict) : null;

type ReauthHandler = (mfa: boolean) => Promise<boolean>;
let reauthHandler: ReauthHandler | null = null;
/** Registers the UI that asks the user to confirm it is them (step-up) when the server requires it. */
export const setReauthHandler = (h: ReauthHandler | null) => {
  reauthHandler = h;
};

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Kernel-Request': '1',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login') && path !== '/api/auth/reauth') window.dispatchEvent(new Event('kernel:unauthorized'));
    // Sensitive action: confirm identity, then retry once.
    if (res.status === 403 && data?.reauth_required && reauthHandler && !retried && (await reauthHandler(!!data.mfa))) {
      return request<T>(method, path, body, true);
    }
    throw new ApiError(res.status, data?.error ?? res.statusText, data ?? {});
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
