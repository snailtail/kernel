/** /api/rules: automation rules, their runs and dry runs. */
export type RuleKind = 'incident' | 'problem' | 'change' | 'request';
type RuleTrigger = { type: 'created' } | { type: 'field_changed'; field: string } | { type: 'status_changed'; to?: string } | { type: 'in_status_for'; status: string; hours: number } | { type: 'due_in'; hours: number };
export type RuleValue = string | number | boolean;
export interface RuleCondition { field: string; op: string; value?: RuleValue | RuleValue[] }
export type RuleAction =
  | { type: 'set_field'; field: string; value: number | null }
  | { type: 'assign_team'; team_id: number }
  | { type: 'add_comment'; text: string }
  | { type: 'notify'; users: number[]; teams: number[]; roles?: NotifyRole[] }
  | { type: 'transition'; to: string }
  | { type: 'webhook'; webhook_id: number };
export type NotifyRole = 'assignee' | 'team_lead' | 'approvers' | 'owner';
export interface RuleDraft { name: string; kind: RuleKind; trigger: RuleTrigger; conditions: RuleCondition[]; actions: RuleAction[] }
export interface Rule extends RuleDraft {
  id: number; enabled: boolean; proposed_by_agent: boolean; recommended: string | null; owner: string | null; created_by: string | null; tripped_at: string | null; updated_at: string;
  matched_30d?: number; failed_30d?: number; last_matched_at?: string | null;
}
interface RuleRun { id: number; record_ref: string; event: RuleTrigger; depth: number; status: string; detail: string; results: { type: string; ok: boolean; note?: string; error?: string }[]; created_at: string; finished_at: string | null }
export interface RuleDetail extends Rule { runs: RuleRun[]; stats_30d: { matched: number; not_matched: number; skipped: number; failed: number } }
export interface RuleList { rules: Rule[]; other_rules: { kind: string; label: string; count: number; enabled: number; path: string }[]; can_manage: boolean; webhooks: { id: number; name: string }[] }
export interface RuleDryRun { days: number; checked: number; matched: number; latest: { ref: string; title: string }[]; note: string }
