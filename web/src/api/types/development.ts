/** /api/work-items (+ /:ref, /move), /api/teams/:id/work-definitions, /board and /api/sprints: development work (#165, #166). */
import type { Guidance } from '../client';
import type { WorkItemStatus } from '../../statuses';

export type WorkItemType = 'epic' | 'story' | 'bug' | 'task';
export interface Progress { points_done: number; points: number; items_done: number; items: number }
export interface WorkItemRow {
  ref: string; item_type: WorkItemType; title: string; status: WorkItemStatus; points: number | null; labels: string[]; rank: number;
  team_id: number | null; team: string | null; assignee_id: number | null; assignee: string | null; parent_ref: string | null; parent_title: string | null;
  created_at: string; updated_at: string; done_at: string | null; progress: Progress | null; sprint_id: number | null;
}
/** The service management records a work item belongs to (#167). */
export type ItsmKind = 'problem' | 'incident' | 'change' | 'improvement' | 'request';
interface WorkItemLink { id: number; kind: 'work_item' | 'document' | ItsmKind; reference: string; system: string; url: string; note: string; title: string | null; status: WorkItemStatus | null; item_type: WorkItemType | null }
export interface Criterion { criterion: string | null; done: boolean }
export interface WorkItem extends Omit<WorkItemRow, 'parent_ref' | 'parent_title'> {
  id: number; description: string | null; acceptance_criteria: Criterion[];
  found_in: string | null; steps_to_reproduce: string | null; expected_result: string | null; actual_result: string | null; remove_reason: string | null;
  created_by: number | null; created_by_name: string | null; started_at: string | null;
  restricted: boolean; restricted_teams: number[]; classification: 'normal' | 'confidential'; confidential_masked?: boolean;
  parent: { ref: string; type: WorkItemType; title: string; status: WorkItemStatus } | null;
  sprint: { id: number; name: string; status: SprintStatus } | null;
  children: { ref: string; type: WorkItemType; title: string; status: WorkItemStatus; points: number | null; assignee: string | null }[];
  definitions: { ready: string[]; done: string[] };
  links: WorkItemLink[];
  transitions: WorkItemStatus[];
  activity: { id: number; kind: string; body: string; data: any; channel: string; created_at: string; user_name: string | null }[];
  next_steps: Guidance;
}
export type BoardColumn = Exclude<WorkItemStatus, 'removed'>;
export interface WorkDefinitions { team_id: number; team: string; ready: string[]; done: string[]; wip_limits: Partial<Record<BoardColumn, number>>; may_edit: boolean }

export type SprintStatus = 'planned' | 'active' | 'completed';
export interface SprintRow {
  id: number; team_id: number; team: string; name: string; goal: string; starts_on: string; ends_on: string; capacity: number | null; status: SprintStatus;
  review_notes: string; started_at: string | null; completed_at: string | null;
  points: { committed: number | null; scope: number; completed: number; left: number; unplanned: number; unplanned_share: number | null };
  items: { total: number; done: number };
  over_capacity: boolean;
}
interface SprintItem {
  ref: string; item_type: WorkItemType; title: string; status: WorkItemStatus; points: number | null; assignee_id: number | null; assignee: string | null;
  added_at: string; unplanned: boolean; outcome: 'done' | 'backlog' | 'next_sprint' | null;
}
export type RetroKind = 'went_well' | 'hard' | 'to_change';
export interface Sprint extends SprintRow {
  work_items: SprintItem[];
  burndown: { day: string; left: number | null; ideal: number }[] | null;
  velocity: { sprints: { id: number; name: string; committed: number; completed: number }[]; average: number | null };
  retrospective: { id: number; kind: RetroKind; body: string; created_at: string; created_by: number | null; created_by_name: string | null; improvement: string | null }[];
  may_manage_retro: boolean;
  next_steps: { phase: string; purpose: string; next: string };
}
export interface BoardCard {
  ref: string; item_type: WorkItemType; title: string; status: BoardColumn; points: number | null; labels: string[];
  assignee_id: number | null; assignee: string | null; parent_ref: string | null; transitions: WorkItemStatus[];
}
export interface Board {
  team_id: number; team: string;
  sprint: { id: number; name: string; goal: string; starts_on: string; ends_on: string; capacity: number | null } | null;
  columns: { status: BoardColumn; wip_limit: number | null; over_limit: boolean; items: BoardCard[] }[];
}

/** A work item linked to a problem (#167): its status, team and sprint. */
export interface LinkedWorkItem { ref: string; item_type: WorkItemType; title: string; status: WorkItemStatus; points: number | null; team: string | null; sprint: string | null; done_at: string | null }

/** /api/records/:ref/trace (#167): the graph of linked records; one the reader may not see has no ref or title. */
export interface TraceNode {
  id: string; type: 'incident' | 'problem' | 'work_item' | 'change' | 'improvement' | 'request'; restricted: boolean;
  ref?: string; title?: string; status?: string; item_type?: WorkItemType; created_at?: string;
}
export interface RecordTrace { ref: string; nodes: TraceNode[]; edges: { from: string; to: string }[]; truncated: boolean }
