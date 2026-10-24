/** /api/dashboard, /api/my-work and /api/review: the dashboard, a person's work list and the problem review agenda. */
import type { Action, Activity, Problem, Status } from '../client';

export interface MyWork {
  problems: { ref: string; title: string; status: Status; priority: number; updated_at: string; url: string }[];
  incidents: { ref: string; title: string; status: string; priority: number; is_major: boolean; created_at: string; update_overdue?: boolean }[];
  reviews?: { ref: string; incident_ref: string; title: string; status: string; due: string | null; overdue: boolean }[];
  improvements?: { ref: string; title: string; status: string; value: number | null; effort: number | null }[];
  /** Service requests (#44), when the module is on. */
  request_tasks?: { ref: string; title: string; task_id: number; task: string; resolution_due_at: string | null }[];
  request_approvals?: { ref: string; title: string; created_at: string }[];
  request_queue?: { ref: string; title: string; task_id: number; task: string; team: string; at_risk: boolean }[];
  major_updates?: { ref: string; title: string; priority: number; next_update_at: string | null; update_overdue: boolean; role: string }[];
  teams?: { id: number; name: string; role: string; unassigned: number }[];
  team_queue?: { ref: string; title: string; status: string; priority: number; is_major: boolean; created_at: string; team: string }[];
  change_votes: { ref: string; title: string; change_type: string; planned_start: string | null }[];
  changes: { ref: string; title: string; status: string; change_type: string; planned_start: string | null }[];
  actions: Action[];
  watched_changes: { ref: string; title: string; kind: string; body: string; created_at: string; by: string | null }[];
  decisions: { ref: string; title: string; priority: number; known_error_at: string }[];
  approvals: { id: number; ref: string; title: string; summary: string; payload: Record<string, unknown>; requested_by: string; created_at: string; human_confirmation: string; changed_since_request: boolean }[];
}
interface ReviewItem {
  ref: string; title: string; status: Status; priority: number; is_major: boolean; assignee_id: number | null; assignee: string | null;
  affected_service: string; created_at: string; updated_at: string; ec_decision: string | null; ec_review_date: string | null;
}
export interface ReviewAgenda {
  generated_at: string;
  stale_days: number;
  sections: { id: string; title: string; hint: string; problems: ReviewItem[] }[];
  overdue_actions: Action[];
}
export interface Dashboard {
  by_status: Partial<Record<Status, number>>;
  open_by_priority: { priority: number; count: number }[];
  open_summary: { under_30: number; d30_90: number; over_90: number; major: number; unassigned: number; needs_decision: number; review_due: number };
  open_links_by_kind: Partial<Record<string, number>>;
  my_problems: Problem[];
  my_actions: Action[];
  actions: { open: number; overdue: number };
  watched_activity: Activity[];
  recent_activity: Activity[];
}
