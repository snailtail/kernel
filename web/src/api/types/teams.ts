/** /api/teams, /api/teams/:id/queue, /api/teams/:id/paging and /api/on-call: teams, their queues and on-call paging. */
export interface Team {
  id: number; name: string; description: string; email: string; auto_assign: 'none' | 'round_robin'; active: boolean;
  members: { user_id: number; name: string; role: 'lead' | 'member' }[]; supports: { ref: string; name: string }[];
  open_incidents: number; unassigned: number; mine: boolean;
}
interface TeamQueueRow { ref: string; title: string; status: string; priority: number; assignee: string | null; created_at: string; at_risk: boolean }
interface TeamRequestTaskRow { ref: string; title: string; task_id: number; task: string; assignee: string | null; opened_at: string; at_risk: boolean }
export interface TeamQueue { team: { id: number; name: string }; unassigned: TeamQueueRow[]; mine: TeamQueueRow[]; at_risk: TeamQueueRow[]; all: TeamQueueRow[]; request_tasks?: TeamRequestTaskRow[] }
export interface OnCallNow { team_id: number; team: string; source: string; people: { name: string; until: string | null }[]; unavailable?: string }
export interface PagingTarget { id: number; kind: string; config: Record<string, any>; rule: { priorities: number[]; major: boolean; services: string[]; hours: string }; enabled: boolean; has_secret: boolean; private_allow: string[] }
export interface TeamPaging { target: PagingTarget | null; rotation: { members: number[]; handover_dow: number; handover_minute: number; timezone: string } | null; overrides: { id: number; user_id: number; name: string; starts_at: string; ends_at: string; reason: string }[]; inbound_url: string | null }
export interface OnCallPage { id: number; action: string; kind: string; reason: string; status: string; attempts: number; error: string; created_at: string; sent_at: string | null; team: string | null; paged_user: string | null }
