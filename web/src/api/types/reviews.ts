/** /api/incident-reviews (+ /:ref): post-incident reviews. */
import type { Action } from '../../api';
import type { ReviewStatus } from '../../statuses';
export type Section = 'what_happened' | 'impact_summary' | 'went_well' | 'was_hard' | 'lucky';
export interface ReviewItem {
  id: number; kind: 'factor' | 'follow_up' | 'gap'; body: string; created_by: string | null; problem_ref: string | null; problem_title: string | null;
  problem_status: string | null;
  action_id: number | null; action_title: string | null; action_status: string | null; action_due: string | null; action_owner: string | null; action_problem_ref: string | null; action_parent_kind: string | null;
  improvement_ref: string | null; improvement_title: string | null; improvement_status: string | null;
}
interface Review {
  ref: string; incident_ref: string; incident_title: string; is_major: boolean; status: ReviewStatus; owner_id: number | null; owner: string | null;
  due: string | null; due_in_days: number | null; overdue: boolean; attendees: string; waived_reason: string; published_at: string | null; published_by: string | null;
  items: ReviewItem[]; actions: Action[]; comments: { id: number; body: string; created_at: string; created_by: string | null }[]; may_finish: boolean; confidential_masked?: boolean;
  context: { timeline: { at: string; label: string; body: string; key_moment: boolean }[]; impact: string; problem_ref: string | null };
  guide: { purpose: string; wording: string; sections: Record<Section, string> };
}
export type ReviewData = Review & Record<Section, string>;
export interface ReviewRow {
  ref: string; incident_ref: string; title: string; is_major: boolean; priority: number; resolved_at: string | null; team: string | null; status: string; owner: string | null; due: string | null;
  overdue: boolean; published_at: string | null; factors: number; factors_to_problems: number; follow_ups: number; follow_ups_to_actions: number; url: string;
}
