// Queues automation rule runs (#49) when a record changes. Each record type's activity log calls it in the change's
// own transaction (the outbox), so a run exists exactly when the change commits; rules.ts runs it after commit.
import { currentContext } from './context.js';
import { afterCommit } from './db.js';
import type { Db } from './problems.js';

export const RULE_KINDS = ['incident', 'problem', 'change', 'request'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/** Activity data keys and the rule field a change to them is. Priority is impact + urgency on most records. */
const FIELD_OF: Record<string, string> = { impact: 'priority', urgency: 'priority', priority: 'priority', category_id: 'category', team_id: 'team', assignee_id: 'assignee' };

let wake: () => void = () => {};
/** The worker in rules.ts registers how to be woken when runs are queued. */
export const onRulesQueued = (fn: () => void) => {
  wake = fn;
};

/** The events one activity entry is, as rule triggers see them. */
export function eventsOf(activity: string, data: any): { type: string; field?: string; to?: string }[] {
  if (activity === 'created') return [{ type: 'created' }];
  if (activity === 'status') {
    const to = data?.to ?? data?.status?.to;
    return typeof to === 'string' ? [{ type: 'status_changed', to }] : [];
  }
  if (activity === 'update') return [...new Set(Object.keys(data ?? {}).map((k) => FIELD_OF[k]).filter(Boolean))].map((field) => ({ type: 'field_changed', field }));
  return [];
}

export async function queueRuleRuns(db: Db, kind: RuleKind, ref: string, activity: string, data: unknown) {
  const events = eventsOf(activity, data);
  if (!events.length) return;
  // A person's change starts a chain at 0; a rule's own change is one level deeper (the loop guard in rules.ts).
  const ctx = currentContext();
  const depth = ctx.actorType === 'rule' ? (ctx.ruleDepth ?? 0) + 1 : 0;
  const { rowCount } = (await db.query(
    `INSERT INTO rule_runs (rule_id, kind, record_ref, event, depth)
     SELECT r.id, $1, $2, e, $4 FROM automation_rules r, jsonb_array_elements($3::jsonb) e
     WHERE r.enabled AND r.kind = $1 AND r.trigger->>'type' = e->>'type'
       AND (r.trigger->>'field' IS NULL OR r.trigger->>'field' = e->>'field')
       AND (r.trigger->>'to' IS NULL OR r.trigger->>'to' = e->>'to')`,
    [kind, ref, JSON.stringify(events), depth],
  )) as { rowCount: number | null };
  if (rowCount) afterCommit(db, () => wake());
}
