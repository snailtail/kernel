/** /api/work-items (+ /:ref, /move) and /api/teams/:id/work-definitions: development work (#165). */
import type { Guidance } from '../client';
import type { WorkItemStatus } from '../../statuses';

export type WorkItemType = 'epic' | 'story' | 'bug' | 'task';
export interface Progress { points_done: number; points: number; items_done: number; items: number }
export interface WorkItemRow {
  ref: string; item_type: WorkItemType; title: string; status: WorkItemStatus; points: number | null; labels: string[]; rank: number;
  team_id: number | null; team: string | null; assignee_id: number | null; assignee: string | null; parent_ref: string | null; parent_title: string | null;
  created_at: string; updated_at: string; done_at: string | null; progress: Progress | null;
}
interface WorkItemLink { id: number; kind: 'work_item' | 'document'; reference: string; system: string; url: string; note: string; title: string | null; status: WorkItemStatus | null; item_type: WorkItemType | null }
export interface Criterion { criterion: string | null; done: boolean }
export interface WorkItem extends Omit<WorkItemRow, 'parent_ref' | 'parent_title'> {
  id: number; description: string | null; acceptance_criteria: Criterion[];
  found_in: string | null; steps_to_reproduce: string | null; expected_result: string | null; actual_result: string | null; remove_reason: string | null;
  created_by: number | null; created_by_name: string | null; started_at: string | null;
  restricted: boolean; restricted_teams: number[]; classification: 'normal' | 'confidential'; confidential_masked?: boolean;
  parent: { ref: string; type: WorkItemType; title: string; status: WorkItemStatus } | null;
  children: { ref: string; type: WorkItemType; title: string; status: WorkItemStatus; points: number | null; assignee: string | null }[];
  definitions: { ready: string[]; done: string[] };
  links: WorkItemLink[];
  transitions: WorkItemStatus[];
  activity: { id: number; kind: string; body: string; data: any; channel: string; created_at: string; user_name: string | null }[];
  next_steps: Guidance;
}
export interface WorkDefinitions { team_id: number; team: string; ready: string[]; done: string[]; may_edit: boolean }
