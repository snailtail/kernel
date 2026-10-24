/** /api/improvements (+ /:ref): continual improvement register. */
import type { Action, Guidance } from '../../api';
import type { ImprovementStatus } from '../../statuses';
export interface ImprovementRow {
  ref: string; title: string; status: ImprovementStatus; source: string; source_ref: string | null; value: number | null; effort: number | null; kpi: string | null;
  owner_id: number | null; owner: string | null; service_ref: string | null; service_name: string | null; created_at: string; updated_at: string; links: number;
}
export interface LinkRow { id: number; kind: string; reference: string; system: string; url: string; note: string; title: string | null; status: string | null; action_problem_ref: string | null; action_path?: string }
export interface Improvement extends Omit<ImprovementRow, 'links'> {
  id: number; description: string | null; benefit: string | null; reject_reason: string | null; created_by: number | null; created_by_name: string | null;
  decided_by_name: string | null; decided_at: string | null; done_at: string | null;
  service: { ref: string; name: string } | null; restricted: boolean; restricted_teams: number[]; classification: 'normal' | 'confidential'; confidential_masked?: boolean;
  links: LinkRow[];
  actions: Action[];
  kpi_tile: { id: string; label: string; value: number | null; unit: 'minutes' | 'percent' | 'count'; trend: (number | null)[]; trend_label: string; lower_is_better: boolean; starts: string[]; link: string } | null;
  transitions: ImprovementStatus[];
  may_decide: boolean;
  activity: { id: number; kind: string; body: string; data: any; channel: string; created_at: string; user_name: string | null }[];
  next_steps: Guidance;
}
