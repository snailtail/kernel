/** /api/requests (+ /:ref) and /api/request-items: service requests and the request catalogue. */
import type { Guidance } from '../client';
import type { RequestStatus } from '../../statuses';
export type FieldType = 'text' | 'textarea' | 'choice' | 'person' | 'ci' | 'date';
export interface Field { key: string; label: string; type: FieldType; required: boolean; choices: string[] }
export type TaskKind = 'manual' | 'change' | 'webhook';
export interface TaskSpec { title: string; team_id: number | null; kind?: TaskKind; webhook_id?: number | null }
export interface CatalogueItem {
  id: number; name: string; description: string; form: Field[]; approval: string; approval_label: string; fulfilment_tasks: TaskSpec[];
  standard_change_template_id: number | null; logger_may_approve: boolean;
  sla_id: number | null; sla: string | null; active: boolean; service: { ref: string; name: string };
}
export interface RequestRow {
  ref: string; title: string; status: RequestStatus; priority: number; item: string; service_ref: string; service_name: string; requester: string;
  created_at: string; updated_at: string; resolution_due_at: string | null; at_risk: boolean; open_task: string | null; open_task_team: string | null; open_task_assignee: string | null;
}
export interface Task { kind: TaskKind; change_ref: string | null; webhook: string | null; by_change: boolean; id: number; position: number; title: string; status: 'pending' | 'open' | 'done' | 'cancelled'; note: string | null; team_id: number | null; team: string | null; assignee_id: number | null; assignee: string | null; done_at: string | null; done_by: string | null; may_complete: boolean }
export interface Clock { state: string; due_at: string | null; remaining_minutes: number | null; target_minutes: number | null }
export interface RequestDetail {
  id: number; ref: string; title: string; status: RequestStatus; priority: number; item: { id: number; name: string }; service: { ref: string; name: string };
  requester: { id: number; name: string; email?: string | null }; on_behalf_of: string | null;
  answers: { key: string; label: string; type: FieldType; value?: string | number | null; answer_text?: string | null; display?: string | null }[];
  approval: { kind: string; approvers: string[]; decided_by: string | null; decided_at: string | null; reject_reason: string | null; may_decide: boolean };
  cancel_reason: string | null; tasks: Task[];
  sla: { name: string; paused: boolean; response: Clock; resolution: Clock } | null;
  links: { id: number; kind: string; reference: string; system: string; url: string; note: string }[];
  activity: { id: number; kind: string; body: string; data: any; channel: string; created_at: string; user_name: string | null }[];
  restricted: boolean; restricted_teams: number[]; classification: 'normal' | 'confidential'; confidential_masked?: boolean; created_by: number | null;
  created_at: string; resolved_at: string | null; transitions: string[]; next_steps: Guidance;
}
