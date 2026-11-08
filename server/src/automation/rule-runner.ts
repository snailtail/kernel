// Running automation rules (#49): the worker that claims queued rule_runs and acts as the rule, and the time-trigger scan.
import type { User } from '../security/auth.js';
import { audit } from '../security/audit.js';
import { contextStore, type RequestContext } from '../core/context.js';
import { type Db, query, tx } from '../core/db.js';
import { logger } from '../core/log.js';
import { notify } from '../notifications/notifications.js';
import { audienceOf } from '../security/audience.js';
import { enqueueTo } from '../notifications/webhooks.js';
import { absoluteUrl } from '../core/url.js';
import { recordType } from '../records/records.js';
import { type RuleKind } from './rule-queue.js';
import { type Facts, MAX_DEPTH, type RuleAction, TRANSITIONS, duration, factsOf, matches, needsServices, words } from './rules.js';

/** The same rule fires at most once per record in this window. */
const REFIRE_MINUTES = 10;
/** More actions than this in a minute turns a rule off. */
const MAX_ACTIONS_PER_MINUTE = 50;

/** Impact and urgency for a priority set by a rule (priority = impact + urgency - 1). */
const LEVELS: Record<number, { impact: number; urgency: number }> = { 1: { impact: 1, urgency: 1 }, 2: { impact: 1, urgency: 2 }, 3: { impact: 2, urgency: 2 }, 4: { impact: 2, urgency: 3 }, 5: { impact: 3, urgency: 3 } };

/** The role a rule acts with: it can never do more than an analyst. */
export const RULE_ROLE = 'analyst' as const;

/** The rule as an actor: the rule role's permissions, no account of its own (histories name it from the channel). */
const actorOf = (rule: { id: number; name: string }): User => ({
  id: null as unknown as number, username: `rule:${rule.id}`, display_name: `Rule '${rule.name}'`, email: '', role: RULE_ROLE, preferences: {}, must_change_password: false, mfa_enabled: true,
});

/** The record's page, for notifications and webhook payloads. */
const pathOf = (kind: RuleKind, ref: string) => `/${kind === 'incident' ? 'incidents' : `${kind}s`}/${ref}`;

/** One line saying why the rule fired, with no record text. */
function why(rule: { name: string }, event: any) {
  if (event?.type === 'due_in') return `Rule '${rule.name}': a follow-up action is due ${event.due}.`;
  if (event?.type === 'in_status_for') return `Rule '${rule.name}': ${words(event.status)} for ${duration(event.hours)}.`;
  return `Rule '${rule.name}' matched.`;
}

/** The people a notify action reaches through the record: its assignee, its team's leads, approvers, an action's owner. */
async function recipients(db: Db, kind: RuleKind, ref: string, a: Extract<RuleAction, { type: 'notify' }>, facts: Facts, event: any) {
  const users: (number | null)[] = [...a.users];
  const { rows: members } = await db.query('SELECT user_id FROM team_members WHERE team_id = ANY($1)', [a.teams]);
  users.push(...members.map((x) => x.user_id));
  for (const role of a.roles) {
    if (role === 'assignee') users.push(facts.assignee);
    if (role === 'owner') users.push(event?.owner_id ?? null);
    if (role === 'team_lead' && facts.team) {
      const { rows } = await db.query("SELECT user_id FROM team_members WHERE team_id = $1 AND role = 'lead'", [facts.team]);
      users.push(...rows.map((x) => x.user_id));
    }
    if (role === 'approvers' && kind === 'request') {
      const { rows } = await db.query('SELECT approver_ids FROM requests WHERE ref = $1', [ref]);
      users.push(...(rows[0]?.approver_ids ?? []));
    }
  }
  return users;
}

/**
 * What a rule's webhook receives: the record as a ref, title, status and priority, never its text. A restricted or
 * confidential record leaves Kernel only as its ref (#53, #61): a webhook lands in chat, where the title is too much.
 */
async function webhookPayload(kind: RuleKind, ref: string, rule: { id: number; name: string }, facts: Facts, event: any) {
  const a = await audienceOf(null, ref);
  const url = absoluteUrl(pathOf(kind, ref));
  const base = { event: 'rule.matched', occurred_at: new Date().toISOString(), rule: { id: rule.id, name: rule.name }, trigger: event?.type ?? null };
  return a.restricted || a.classification === 'confidential'
    ? { ...base, record: { kind, ref, restricted: a.restricted, classification: a.classification, url }, summary: 'A restricted or confidential record matched a rule.' }
    : { ...base, record: { kind, ref, title: facts.title, status: facts.status, priority: facts.priority, url }, summary: why(rule, event) };
}

async function runAction(kind: RuleKind, ref: string, a: RuleAction, rule: { id: number; name: string }, run: { id: number; event: any }, facts: Facts) {
  const actor = actorOf(rule);
  const fields = (field: string, value: number | null): Record<string, unknown> =>
    field === 'priority' ? (kind === 'request' ? { priority: value } : LEVELS[value!]) : { [{ category: 'category_id', team: 'team_id', assignee: 'assignee_id' }[field]!]: value };
  // Through each practice's own rules, from the record registry (the runner sits below the practices).
  const type = recordType(kind);
  const update = (input: Record<string, unknown>) => type.update!(actor, ref, input);
  switch (a.type) {
    case 'set_field': return update(fields(a.field, a.value));
    case 'assign_team': return update({ team_id: a.team_id });
    case 'add_comment': {
      return void (await type.comment(actor, ref, a.text));
    }
    case 'transition': {
      const from = TRANSITIONS[kind]?.[a.to];
      if (facts.status !== from) return 'not needed';
      return type.transition!(actor, ref, { to: a.to });
    }
    case 'notify': {
      // Only people who may see the record are told (notify checks each one), and only its ref and title: never text.
      return tx(async (db) => {
        const sent = await notify(db, {
          users: await recipients(db, kind, ref, a, facts, run.event), event: 'automation', ref, title: facts.title, summary: why(rule, run.event),
          path: pathOf(kind, ref), dedupe: `rule:${rule.id}:${run.id}`,
        });
        return `${sent} notified`;
      });
    }
    case 'webhook': {
      const payload = await webhookPayload(kind, ref, rule, facts, run.event);
      const queued = await tx((db) => enqueueTo(db, a.webhook_id, 'rule.matched', payload));
      if (!queued) throw new Error('The webhook is turned off or removed');
      return 'queued';
    }
  }
}

/** The context a run acts in: the rule as the actor, the system as the viewer, and how deep in a chain it is. */
const ruleContext = (rule: { id: number; name: string }, run: { id: number; depth: number }): RequestContext => ({
  userId: null, userName: `rule '${rule.name}'`, actorType: 'rule', channel: `rule:${rule.id}`, tokenPrefix: '', ip: '', userAgent: '',
  requestId: `rule-run-${run.id}`, viewer: 'system', ruleDepth: run.depth,
});

const finish = (runId: number, status: string, detail = '', results: unknown[] = []) =>
  query('UPDATE rule_runs SET status = $2, detail = $3, results = $4, finished_at = now(), lease_until = NULL WHERE id = $1', [runId, status, detail, JSON.stringify(results)]);

/** Runs one queued run: the loop guards, the conditions, then the actions one by one. */
async function runOne(run: any) {
  const { rows } = await query('SELECT * FROM automation_rules WHERE id = $1', [run.rule_id]);
  const rule = rows[0];
  if (!rule?.enabled) return finish(run.id, 'skipped', 'The rule was turned off before it ran');
  const kind = run.kind as RuleKind;
  if (run.depth >= MAX_DEPTH) {
    const detail = `Stopped: ${MAX_DEPTH} rules already ran in a row on this record (the loop guard)`;
    await contextStore.run(ruleContext(rule, run), () => audit(null, { entity_type: kind, entity_ref: run.record_ref, action: 'rule_stopped', changes: { rule: rule.name, depth: run.depth } }));
    return finish(run.id, 'skipped', detail);
  }
  const [facts] = await factsOf(kind, { refs: [run.record_ref] }, needsServices(rule.conditions));
  if (!facts) return finish(run.id, 'skipped', 'The record no longer exists');
  // A time trigger is checked again when it runs: the record may have moved on since the scan.
  if (run.event.type === 'in_status_for' && facts.status !== run.event.status) return finish(run.id, 'skipped', `No longer ${words(run.event.status)}`);
  if (run.event.type === 'due_in') {
    const { rows: open } = await query("SELECT 1 FROM actions WHERE id = $1 AND status = 'open' AND due_date = $2::date", [run.event.action_id, run.event.due]);
    if (!open[0]) return finish(run.id, 'skipped', 'The action is done or its due date moved');
  }
  if (!matches(rule.conditions, facts)) return finish(run.id, 'not_matched');
  // A time trigger fires once per window already (window_key); the 10-minute rule is for chains of changes.
  const { rows: recent } = run.window_key ? { rows: [] } : await query(
    `SELECT 1 FROM rule_runs WHERE rule_id = $1 AND record_ref = $2 AND status = 'matched' AND finished_at > now() - $3 * interval '1 minute' AND id <> $4 LIMIT 1`,
    [rule.id, run.record_ref, REFIRE_MINUTES, run.id],
  );
  if (recent[0]) return finish(run.id, 'skipped', `Already fired on this record in the last ${REFIRE_MINUTES} minutes`);
  // The circuit breaker: a rule that suddenly does a lot is turned off before it does more.
  const { rows: rate } = await query(
    `SELECT coalesce(sum(jsonb_array_length(results)), 0)::int AS n FROM rule_runs WHERE rule_id = $1 AND status = 'matched' AND finished_at > now() - interval '1 minute'`,
    [rule.id],
  );
  if (rate[0].n + rule.actions.length > MAX_ACTIONS_PER_MINUTE) {
    await trip(rule, run);
    return finish(run.id, 'skipped', `Turned off: more than ${MAX_ACTIONS_PER_MINUTE} actions in a minute (the circuit breaker)`);
  }
  const results: { type: string; ok: boolean; note?: string; error?: string }[] = [];
  await contextStore.run(ruleContext(rule, run), async () => {
    for (const a of rule.actions as RuleAction[]) {
      try {
        const note = await runAction(kind, run.record_ref, a, rule, run, facts);
        results.push({ type: a.type, ok: true, ...(typeof note === 'string' ? { note } : {}) });
      } catch (err) {
        results.push({ type: a.type, ok: false, error: (err as Error).message.slice(0, 300) });
      }
    }
  });
  const failed = results.filter((r) => !r.ok).length;
  return finish(run.id, failed === results.length ? 'failed' : 'matched', failed ? `${failed} of ${results.length} actions failed` : '', results);
}

/** Turns a rule off and tells its owner (or whoever wrote it). */
async function trip(rule: any, run: any) {
  await tx(async (db) => {
    const { rowCount } = (await db.query('UPDATE automation_rules SET enabled = false, tripped_at = now() WHERE id = $1 AND enabled', [rule.id])) as { rowCount: number | null };
    if (!rowCount) return;
    await contextStore.run(ruleContext(rule, run), () =>
      audit(db, { entity_type: 'automation_rule', entity_ref: `#${rule.id}`, action: 'tripped', changes: { name: rule.name, enabled: { from: true, to: false }, limit: MAX_ACTIONS_PER_MINUTE } }));
    await notify(db, {
      users: [rule.owner_id ?? rule.created_by], event: 'automation', ref: `RULE-${rule.id}`, title: rule.name,
      summary: `Turned off: it took more than ${MAX_ACTIONS_PER_MINUTE} actions in a minute. Check it, then enable it again.`,
      path: `/rules/${rule.id}`, dedupe: `rule-tripped:${rule.id}:${Date.now()}`,
    });
  });
  logger.warn({ event: { dataset: 'kernel.rules', action: 'rule.tripped' }, rule: rule.id }, 'automation rule turned off by its circuit breaker');
}

// ---- Time triggers ---------------------------------------------------------------------------
// #173: the scan queues into rule_runs like a change does; it moves with the shared outbox helper when that comes.

const RECORD_TABLES: Record<RuleKind, { table: string; activity: string; fk: string }> = {
  incident: { table: 'incidents', activity: 'incident_activity', fk: 'incident_id' },
  problem: { table: 'problems', activity: 'problem_activity', fk: 'problem_id' },
  change: { table: 'changes', activity: 'change_activity', fk: 'change_id' },
  request: { table: 'requests', activity: 'request_activity', fk: 'request_id' },
};
/** At most this many runs per rule and scan; the rest come in the next minute. */
const SCAN_BATCH = 200;

/**
 * Finds what the enabled time rules are waiting for and queues one run per record and window: the moment the record
 * entered the status, or the action and its due date. One replica scans at a time (an advisory lock as the lease);
 * the unique window key makes a second scan harmless anyway. Returns how many runs were queued.
 */
export async function scanTimeTriggers(): Promise<number> {
  return tx(async (db) => {
    const { rows: lock } = await db.query('SELECT pg_try_advisory_xact_lock(4949) AS ok');
    if (!lock[0].ok) return 0;
    const { rows: rules } = await db.query("SELECT id, kind, trigger FROM automation_rules WHERE enabled AND trigger->>'type' IN ('in_status_for', 'due_in')");
    let queued = 0;
    for (const r of rules) {
      const kind = r.kind as RuleKind;
      const t = RECORD_TABLES[kind];
      const { rowCount } = (r.trigger.type === 'in_status_for'
        ? await db.query(
          // When it entered the status: its latest move there, or its creation if it never moved.
          `INSERT INTO rule_runs (rule_id, kind, record_ref, event, window_key)
           SELECT $1, $2, x.ref, jsonb_build_object('type', 'in_status_for', 'status', $3::text, 'hours', $4::numeric, 'since', x.since),
                  'in:' || $3 || ':' || extract(epoch FROM x.since)::bigint
           FROM (SELECT r.ref, coalesce((SELECT max(a.created_at) FROM ${t.activity} a WHERE a.${t.fk} = r.id AND a.kind = 'status'
                                           AND coalesce(a.data->>'to', a.data->'status'->>'to') = $3), r.created_at) AS since
                 FROM ${t.table} r WHERE r.status = $3) x
           WHERE x.since <= now() - $4 * interval '1 hour'
           ORDER BY x.since LIMIT ${SCAN_BATCH}
           ON CONFLICT (rule_id, record_ref, window_key) WHERE window_key IS NOT NULL DO NOTHING`,
          [r.id, kind, r.trigger.status, r.trigger.hours],
        )
        : await db.query(
          `INSERT INTO rule_runs (rule_id, kind, record_ref, event, window_key)
           SELECT $1, $3, p.ref, jsonb_build_object('type', 'due_in', 'hours', $2::int, 'action_id', a.id, 'owner_id', a.owner_id, 'due', a.due_date::text),
                  'due:' || a.id || ':' || a.due_date::text
           FROM actions a JOIN ${t.table} p ON a.parent_kind = $3 AND p.id = a.parent_id
           WHERE a.status = 'open' AND a.due_date >= current_date AND a.due_date::timestamptz <= now() + $2 * interval '1 hour'
           ORDER BY a.due_date LIMIT ${SCAN_BATCH}
           ON CONFLICT (rule_id, record_ref, window_key) WHERE window_key IS NOT NULL DO NOTHING`,
          [r.id, r.trigger.hours, kind],
        )) as { rowCount: number | null };
      queued += rowCount ?? 0;
    }
    return queued;
  });
}

let running: Promise<number> | null = null;

/** Claims queued runs with a lease and runs them in order. Returns how many ran. */
export async function processRuleRuns(): Promise<number> {
  if (running) return running;
  running = (async () => {
    let done = 0;
    for (;;) {
      // A run whose worker died is claimed again once its lease is over, three times at most.
      const { rows } = await query(
        `UPDATE rule_runs SET status = 'running', lease_until = now() + interval '2 minutes', attempts = attempts + 1
         WHERE id IN (SELECT id FROM rule_runs WHERE (status = 'pending' OR (status = 'running' AND lease_until < now())) AND attempts < 3
                      ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED)
         RETURNING *`,
      );
      if (!rows.length) break;
      for (const run of rows.sort((a, b) => Number(a.id) - Number(b.id))) {
        try {
          await runOne(run);
        } catch (err) {
          await finish(run.id, 'failed', (err as Error).message.slice(0, 300));
        }
        done++;
      }
    }
    await query("UPDATE rule_runs SET status = 'failed', detail = 'Gave up after 3 attempts', finished_at = now(), lease_until = NULL WHERE status = 'running' AND lease_until < now() AND attempts >= 3");
    return done;
  })().finally(() => {
    running = null;
  });
  return running;
}

const asWorker = <T>(fn: () => Promise<T>) => contextStore.run({ userId: null, userName: 'rules', actorType: 'system', channel: 'system', tokenPrefix: '', ip: '', userAgent: '', requestId: '', viewer: 'system' }, fn);

/** Runs queued rule runs as the rules actor. */
export const runRules = () => asWorker(() => processRuleRuns());

/** Looks for due time triggers; returns how many runs they queued. */
export const runTimeTriggers = () => asWorker(() => scanTimeTriggers());

/** The log keeps what a rule did for a year; runs that did not match only for a week. */
export const pruneRuleRuns = () => asWorker(() => query(
  "DELETE FROM rule_runs WHERE (status = 'not_matched' AND created_at < now() - interval '7 days') OR created_at < now() - interval '365 days'",
));
