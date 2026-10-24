/** /api/incidents (+ /:ref), major-incident, status-proposal, related and timeline endpoints. */
import type { IncidentStatus } from '../../statuses';
import type { PersonLite } from './people';
import type { AffectedCi, AffectedService, ImpactHint } from './cmdb';
import type { ArticleRow } from './knowledge';
export interface IncidentRow {
  id: number; ref: string; title: string; status: IncidentStatus; priority: number; is_major: boolean; assignee: string | null;
  assignment_group: string; source: string; created_at: string; resolved_at: string | null; problem_ref: string | null; cis: string[] | null;
  sla_state?: string | null; resolution_due_at?: string | null;
  next_update_at?: string | null; update_overdue?: boolean; parent_ref?: string | null; child_count?: number;
}
export interface Incident extends IncidentRow {
  description: string; impact: number; urgency: number; category_id: number | null; category: string | null; assignee_id: number | null; team_id: number | null; team_hops: number;
  reporter: string; hold_reason: string; resolution_code: string | null; resolution: string; reopen_count: number;
  responded_at: string | null; closed_at: string | null; problem_title: string | null; problem_status: string | null;
  affected_cis: AffectedCi[]; affected_services: AffectedService[]; impact_hint: ImpactHint | null; impact_incomplete: boolean;
  contains_personal_data?: boolean; restricted: boolean; restricted_teams: number[];
  suggested_articles?: ArticleRow[]; articles_used?: { ref: string; title: string }[];
  caller: PersonLite | null; affected_people: PersonLite[]; people_hint: { suggested_impact: number; reason: string } | null; asks_affected_users: boolean;
  sla: { name: string; calendar: string; paused: boolean; response: SlaClock; resolution: SlaClock } | null;
  possible_change_causes: { ref: string; title: string; status: string; change_type: string; outcome: string | null; started_at: string; ci: string; ci_name: string }[];
  known_errors: { ref: string; title: string; workaround: string; workaround_effectiveness: string | null; ci_ref: string; ci_name: string }[];
  links: { id: number; kind: string; reference: string; system: string; url: string }[];
  alerts: { id: number; source: string; check_key: string; severity: string; status: string; count: number; flap_count: number; last_seen: string; ci_hint: string; ci_ref: string | null; ci_name: string | null; source_url: string }[];
  activity: { id: number; kind: string; body: string; data: any; channel: string; key_moment: boolean; created_at: string; user_name: string | null }[];
  major: MajorInfo | null; review: ReviewSummary | null; pages: PageNotice[]; parent: RelatedRow | null; children: RelatedRow[]; suggested_parent: RelatedRow | null; status_proposal: StatusProposal | null;
  next_steps: { phase: string; purpose: string; next: string; steps: { id: string; label: string; hint: string; done: boolean }[] };
}
interface SlaClock { target_minutes: number | null; due_at: string | null; elapsed_minutes: number; remaining_minutes: number | null; state: string; met_at?: string | null }
interface PageNotice { id: number; action: string; kind: string; reason: string; status: string; attempts: number; error: string; created_at: string; sent_at: string | null; team: string | null; paged_user: string | null }
export interface MajorInfo {
  declared_at: string | null; lead_id: number | null; lead: string | null; comms_id: number | null; comms: string | null; bridge: string;
  update_minutes: number | null; next_update_at: string | null; update_overdue: boolean; last_update: { body: string; created_at: string } | null;
  communications: Communication[];
}
/** A status update on the incident and who outside was told (#46). */
export interface Communication {
  id: number; created_at: string; phase: string; message: string; public: boolean; retracted_at: string | null; author: string | null;
  contacts: { person_id: number | null; name: string | null; organisation: string; status: string; sent_at: string | null }[];
  subscribers_sent: number; subscribers_pending: number; subscribers_last_sent_at: string | null;
}
export interface ReviewSummary { status: 'scheduled' | 'draft' | 'published' | 'waived'; owner: string | null; due: string | null; due_in_days: number | null; overdue: boolean; published_at: string | null }
export interface RelatedRow { ref: string; title: string; status: string; priority?: number; resolve_with_parent?: boolean; is_major?: boolean }
export interface StatusProposal { services: string[]; status: string; phase: string; message: string }
export interface TimelineEntry { activity_id: number; at: string; kind: string; key_moment: boolean; by: string | null; label: string; body: string }
