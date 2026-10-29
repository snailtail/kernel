/** /api/changes (+ /:ref). */
import type { Guidance } from '../client';
import type { ChangeStatus } from '../../statuses';
import type { AffectedCi, AffectedService } from './cmdb';
import type { LinkedWorkItem } from './development';
export interface ChangeRow { id: number; ref: string; title: string; change_type: string; status: ChangeStatus; risk: string | null; planned_start: string | null; planned_end: string | null; outcome: string | null; source: string; assignee: string | null; problem_ref: string | null; cis: string[] | null }
export interface Change extends ChangeRow {
  description: string; template: string | null; template_id: number | null; implementation_plan: string; test_plan: string; backout_plan: string; review: string;
  risk: string; risk_assessed: string; risk_reason: string; risk_overridden: boolean; actual_start: string | null; actual_end: string | null; assignee_id: number | null;
  requested_by: string | null; problem_title: string | null; problem_status: string | null; created_at: string;
  affected_cis: AffectedCi[]; affected_services: AffectedService[];
  /** The bugs and stories it delivers, with the development module on (#167). */
  work_items?: LinkedWorkItem[];
  votes: { approver: string; decision: string; comment: string; created_at: string }[]; approvals: { required: number; approved: number }; can_vote: boolean;
  collisions: { ref: string; title: string; ci: string; planned_start: string; planned_end: string }[]; freezes: { name: string; starts_at: string; ends_at: string; reason: string }[];
  related_incidents: { ref: string; title: string; status: string; created_at: string }[];
  links: { id: number; kind: string; reference: string; system: string; url: string }[];
  activity: { id: number; kind: string; body: string; data: any; channel: string; created_at: string; user_name: string | null }[];
  next_steps: Guidance;
  contains_personal_data?: boolean; restricted: boolean; restricted_teams: number[];
}
