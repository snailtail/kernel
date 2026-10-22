import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('automation rules (#49)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, analyst2: Client, viewer: Client;
  let db: typeof import('../../src/db.js');
  let rules: typeof import('../../src/rules.js');
  const ids: Record<string, number> = {};
  let payroll: string, payrollDb: string, hr: any, ops: any, cat: number;

  const run = () => rules.processRuleRuns();
  const ok = (r: { status: number; body: any }, status = 200) => {
    assert.equal(r.status, status, JSON.stringify(r.body));
    return r.body;
  };
  const rule = (over: Record<string, unknown> = {}) => ({
    name: `Rule ${Math.random().toString(36).slice(2, 8)}`, kind: 'incident', trigger: { type: 'created' }, conditions: [], actions: [{ type: 'add_comment', text: 'Checked by a rule' }], ...over,
  });
  const enabled = async (body: Record<string, unknown>) => {
    const r = ok(await pm.post('/api/rules', body), 201);
    ok(await pm.put(`/api/rules/${r.id}/enabled`, { enabled: true }));
    return r;
  };
  const disableAll = async () => {
    for (const r of (await pm.get('/api/rules')).body.rules) if (r.enabled) await pm.put(`/api/rules/${r.id}/enabled`, { enabled: false });
  };

  before(async () => {
    // Outgoing webhooks keep their signing secret encrypted.
    process.env.KERNEL_SECRET_KEY = 'test-secret-key-0123456789abcdefghijklmnop';
    k = await startKernel();
    [admin, pm, analyst, analyst2, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('analyst2'), k.login('viewer')]);
    db = await import('../../src/db.js');
    rules = await import('../../src/rules.js');
    for (const u of (await db.query('SELECT id, username FROM users')).rows) ids[u.username] = u.id;
    payroll = ok(await pm.post('/api/cis', { name: 'Payroll', ci_type: 'business_service' }), 201).ref;
    payrollDb = ok(await pm.post('/api/cis', { name: 'payroll-db01', ci_type: 'database' }), 201).ref;
    await pm.post(`/api/cis/${payrollDb}/relationships`, { type: 'member_of', target: payroll });
    hr = ok(await admin.post('/api/teams', { name: 'HR-Systems' }), 201);
    ops = ok(await admin.post('/api/teams', { name: 'Operations' }), 201);
    await admin.put(`/api/teams/${hr.id}/members`, { members: [{ user_id: ids.analyst, role: 'lead' }] });
    await admin.put(`/api/teams/${ops.id}/members`, { members: [{ user_id: ids.analyst2 }] });
    cat = (await db.query('SELECT id FROM categories ORDER BY id LIMIT 1')).rows[0].id;
  });
  after(async () => {
    delete process.env.KERNEL_SECRET_KEY;
    await k?.close();
  });

  test('only allowlisted fields, operators and actions are accepted; only problem managers write rules', async () => {
    assert.equal((await pm.post('/api/rules', rule({ conditions: [{ field: 'description', op: 'is', value: 'x' }] }))).status, 400, 'free text is never a condition');
    assert.equal((await pm.post('/api/rules', rule({ conditions: [{ field: 'priority', op: 'matches', value: 1 }] }))).status, 400, 'unknown operator');
    assert.equal((await pm.post('/api/rules', rule({ actions: [{ type: 'run_script', script: 'rm -rf' }] }))).status, 400, 'unknown action');
    assert.equal((await pm.post('/api/rules', rule({ actions: [{ type: 'set_field', field: 'classification', value: 1 }] }))).status, 400, 'never classification');
    assert.equal((await pm.post('/api/rules', rule({ actions: [{ type: 'set_field', field: 'restricted', value: 1 }] }))).status, 400, 'never restriction');
    assert.equal((await pm.post('/api/rules', rule({ actions: [{ type: 'add_comment', text: 'Hi', to_requester: true }] }))).status, 400, 'never a reply to the requester');
    assert.equal((await pm.post('/api/rules', rule({ actions: [{ type: 'transition', to: 'resolved' }] }))).status, 400, 'only closing a resolved incident or taking one off hold');
    assert.equal((await pm.post('/api/rules', rule({ kind: 'problem', actions: [{ type: 'transition', to: 'closed' }] }))).status, 400, 'a rule never closes a problem');
    assert.equal((await pm.post('/api/rules', rule({ kind: 'change', actions: [{ type: 'set_field', field: 'priority', value: 1 }] }))).status, 400, 'a change has no priority');
    assert.equal((await pm.post('/api/rules', rule({ trigger: { type: 'field_changed', field: 'title' } }))).status, 400, 'no trigger on text');
    assert.equal((await pm.post('/api/rules', rule({ conditions: [{ field: 'team', op: 'is', value: 99999 }] }))).status, 400, 'an unknown team');
    assert.equal((await pm.post('/api/rules', rule({ conditions: [{ field: 'service', op: 'in', value: 'SVC000001' }] }))).status, 400, '"in" takes a list');
    assert.equal((await pm.post('/api/rules', { ...rule(), extra: true })).status, 400, 'no unknown keys');
    assert.equal((await analyst.post('/api/rules', rule())).status, 403);
    const r = ok(await pm.post('/api/rules', rule({ name: 'Draft' })), 201);
    assert.equal(r.enabled, false, 'a new rule starts disabled');
    assert.match(r.sentence, /^When an incident is created, then add an internal note\.$/);
    assert.equal((await analyst.put(`/api/rules/${r.id}/enabled`, { enabled: true })).status, 403);
    assert.equal((await viewer.get('/api/rules')).status, 200, 'everyone can see what rules exist');
    ok(await pm.del(`/api/rules/${r.id}`));
    const trail = (await db.query("SELECT action, changes FROM audit_log WHERE entity_type = 'automation_rule' AND entity_ref = $1 ORDER BY id", [`#${r.id}`])).rows;
    assert.deepEqual(trail.map((t: any) => t.action), ['create', 'delete']);
    assert.equal(trail[1].changes.before.name, 'Draft', 'the trail keeps what was removed');
  });

  test('a rule routes a new incident through the service layer, after commit, and says so in the history', async () => {
    const r = await enabled(rule({
      name: 'Payroll routing', conditions: [{ field: 'service', op: 'is', value: payroll.toLowerCase() }],
      actions: [{ type: 'assign_team', team_id: hr.id }, { type: 'add_comment', text: 'Routed to HR-Systems by rule' }],
    }));
    assert.equal(r.conditions[0].value, payroll, 'CI refs are kept upper case');
    const before = ok(await analyst2.post('/api/incidents', { title: 'Payslips missing', cis: [payrollDb] }), 201);
    assert.notEqual(before.team_id, hr.id, 'the person\'s save is untouched; the rule runs after commit');
    const other = ok(await analyst2.post('/api/incidents', { title: 'Printer jam' }), 201);
    await run();
    const after = ok(await analyst2.get(`/api/incidents/${before.ref}`));
    assert.equal(after.team_id, hr.id, 'the service is found through the CMDB');
    assert.equal(after.assignee_id, null, 'not a member of HR-Systems: handed to the queue');
    const note = after.activity.find((a: any) => a.kind === 'comment');
    assert.equal(note.user_name, "Rule 'Payroll routing'");
    assert.equal(note.body, 'Routed to HR-Systems by rule');
    assert.equal((ok(await analyst2.get(`/api/incidents/${other.ref}`))).team_id, null, 'conditions hold back the rest');
    const history = ok(await analyst2.get(`/api/records/${before.ref}/history`));
    const moved = history.find((e: any) => e.changes?.team_id);
    assert.equal(moved.actor_name, "Rule 'Payroll routing'");
    assert.equal(moved.actor_type, 'rule');
    assert.equal(moved.actor_user_id, null, 'a rule has no account');
    const queue = (await db.query("SELECT user_id FROM notifications WHERE event = 'team_queue' AND ref = $1", [before.ref])).rows;
    assert.deepEqual(queue.map((q: any) => q.user_id), [ids.analyst], 'the same notifications as when a person moves it');
    const detail = ok(await pm.get(`/api/rules/${r.id}`));
    assert.equal(detail.runs.length, 1, 'the run log has the match, not the miss');
    assert.equal(detail.runs[0].record_ref, before.ref);
    assert.deepEqual(detail.runs[0].results.map((x: any) => x.ok), [true, true]);
    assert.equal(detail.stats_30d.not_matched, 1);
    await disableAll();
  });

  test('a rule can do no more than an analyst, and a failing action never fails the save', async () => {
    const { PERMISSIONS } = await import('../../src/policy.js');
    assert.equal(rules.RULE_ROLE, 'analyst');
    for (const manage of ['problem.close', 'incident.flag_major', 'rule.manage', 'record.restrict', 'record.redact', 'change.approve'] as const) {
      if (manage === 'record.restrict') continue; // analysts restrict their own records; rules have no action for it
      assert.ok(!PERMISSIONS[rules.RULE_ROLE].has(manage), manage);
    }
    await enabled(rule({ name: 'Bad assignee', actions: [{ type: 'set_field', field: 'assignee', value: ids.viewer }, { type: 'set_field', field: 'priority', value: 2 }] }));
    const i = ok(await analyst.post('/api/incidents', { title: 'Something broke' }), 201);
    await run();
    const got = ok(await analyst.get(`/api/incidents/${i.ref}`));
    assert.equal(got.assignee_id, null, 'validation applies to rules too: a viewer cannot be assigned');
    assert.equal(got.priority, 2, 'the other action still ran');
    assert.equal(got.impact, 1);
    const { rows } = await db.query("SELECT status, detail, results FROM rule_runs WHERE record_ref = $1", [i.ref]);
    assert.equal(rows[0].status, 'matched');
    assert.match(rows[0].detail, /1 of 2 actions failed/);
    assert.match(rows[0].results[0].error, /Assignee/);
    await disableAll();
  });

  test('rules act on problems, changes and service requests through their own service functions', async () => {
    ok(await admin.put('/api/admin/modules', { request: true, reason: 'Rules on requests' }));
    await enabled(rule({ name: 'Problems to HR', kind: 'problem', actions: [{ type: 'assign_team', team_id: hr.id }, { type: 'set_field', field: 'priority', value: 1 }, { type: 'add_comment', text: 'Triage today' }] }));
    await enabled(rule({ name: 'Changes to Operations', kind: 'change', actions: [{ type: 'assign_team', team_id: ops.id }, { type: 'add_comment', text: 'Operations reviews every change' }] }));
    await enabled(rule({ name: 'Payroll requests first', kind: 'request', conditions: [{ field: 'service', op: 'is', value: payroll }], actions: [{ type: 'set_field', field: 'priority', value: 2 }, { type: 'add_comment', text: 'Payroll: within the day' }] }));
    const p = ok(await analyst.post('/api/problems', { title: 'Payslips late every month' }), 201);
    const c = ok(await analyst.post('/api/changes', { title: 'Patch payroll-db01' }), 201);
    const item = ok(await pm.post('/api/request-items', { service: payroll, name: 'Payroll access', fulfilment_tasks: [{ title: 'Grant it', team_id: hr.id }] }), 201);
    const person = ok(await pm.post('/api/people', { name: 'Petra Payroll', email: 'petra@example.com' }), 201);
    const r = ok(await analyst.post('/api/requests', { item_id: item.id, requester: { id: person.id } }), 201);
    await run();
    const runs = (await db.query('SELECT record_ref, status, results FROM rule_runs WHERE record_ref = ANY($1)', [[p.ref, c.ref, r.ref]])).rows;
    assert.equal(runs.length, 3);
    for (const x of runs) assert.ok(x.status === 'matched' && x.results.every((a: any) => a.ok), JSON.stringify(x));
    const gp = ok(await analyst.get(`/api/problems/${p.ref}`));
    assert.equal(gp.team_id, hr.id);
    assert.equal(gp.priority, 1);
    assert.equal(gp.activity.find((a: any) => a.kind === 'comment').user_name, "Rule 'Problems to HR'");
    assert.equal(ok(await analyst.get(`/api/changes/${c.ref}`)).team_id, ops.id);
    const gr = ok(await analyst.get(`/api/requests/${r.ref}`));
    assert.equal(gr.priority, 2);
    assert.equal(gr.activity.find((a: any) => a.kind === 'comment').user_name, "Rule 'Payroll requests first'");
    await disableAll();
  });

  test('the loop guard: a chain stops at depth 3, and A → B → A stops on the second A', async () => {
    // A person's change → R1 (depth 0) → R2 (1) → R3 (2) → R4 would be the fourth rule in a row.
    await enabled(rule({ name: 'R1 raise', actions: [{ type: 'set_field', field: 'priority', value: 2 }] }));
    await enabled(rule({ name: 'R2 categorise', trigger: { type: 'field_changed', field: 'priority' }, actions: [{ type: 'set_field', field: 'category', value: cat }] }));
    await enabled(rule({ name: 'R3 route', trigger: { type: 'field_changed', field: 'category' }, actions: [{ type: 'assign_team', team_id: hr.id }] }));
    const r4 = await enabled(rule({ name: 'R4 assign', trigger: { type: 'field_changed', field: 'team' }, actions: [{ type: 'set_field', field: 'assignee', value: ids.analyst }] }));
    const i = ok(await analyst2.post('/api/incidents', { title: 'Chain reaction' }), 201);
    await run();
    const got = ok(await analyst2.get(`/api/incidents/${i.ref}`));
    assert.equal(got.priority, 2);
    assert.equal(got.category_id, cat);
    assert.equal(got.team_id, hr.id);
    assert.equal(got.assignee_id, null, 'the fourth rule in a row did not run');
    const stopped = (await db.query("SELECT depth, status, detail FROM rule_runs WHERE rule_id = $1 AND record_ref = $2", [r4.id, i.ref])).rows[0];
    assert.equal(stopped.depth, 3);
    assert.equal(stopped.status, 'skipped');
    assert.match(stopped.detail, /loop guard/);
    const history = ok(await analyst2.get(`/api/records/${i.ref}/history`));
    assert.ok(history.some((e: any) => e.action === 'rule_stopped' && e.actor_name === "Rule 'R4 assign'"), 'the stop is in the record\'s history');
    await disableAll();

    // A sets the team when the priority changes; B raises the priority when the team changes.
    const a = await enabled(rule({ name: 'A team on priority', trigger: { type: 'field_changed', field: 'priority' }, actions: [{ type: 'assign_team', team_id: ops.id }] }));
    await enabled(rule({ name: 'B priority on team', trigger: { type: 'field_changed', field: 'team' }, actions: [{ type: 'set_field', field: 'priority', value: 1 }] }));
    const j = ok(await analyst.post('/api/incidents', { title: 'Ping pong' }), 201);
    ok(await analyst.patch(`/api/incidents/${j.ref}`, { impact: 2 }));
    await run();
    const runsA = (await db.query('SELECT depth, status, detail FROM rule_runs WHERE rule_id = $1 AND record_ref = $2 ORDER BY id', [a.id, j.ref])).rows;
    assert.deepEqual(runsA.map((x: any) => [x.depth, x.status]), [[0, 'matched'], [2, 'skipped']]);
    assert.match(runsA[1].detail, /last 10 minutes/);
    assert.equal(ok(await analyst.get(`/api/incidents/${j.ref}`)).priority, 1);
    await disableAll();
  });

  test('the circuit breaker turns a rule off after 50 actions in a minute and tells its owner', async () => {
    const noisy = await enabled(rule({ name: 'Noisy', actions: Array.from({ length: 10 }, (_, n) => ({ type: 'add_comment', text: `Note ${n}` })) }));
    const refs: string[] = [];
    for (let n = 0; n < 6; n++) refs.push(ok(await analyst.post('/api/incidents', { title: `Burst ${n}` }), 201).ref);
    await run();
    const r = ok(await pm.get(`/api/rules/${noisy.id}`));
    assert.equal(r.enabled, false);
    assert.ok(r.tripped_at);
    assert.equal(r.stats_30d.matched, 5);
    const last = (await db.query('SELECT status, detail FROM rule_runs WHERE rule_id = $1 AND record_ref = $2', [noisy.id, refs[5]])).rows[0];
    assert.equal(last.status, 'skipped');
    assert.match(last.detail, /circuit breaker/);
    const told = (await db.query("SELECT summary FROM notifications WHERE event = 'automation' AND user_id = $1 AND url = $2", [ids.pm, `/rules/${noisy.id}`])).rows;
    assert.equal(told.length, 1, 'the owner (who enabled it) is told');
    assert.ok((await db.query("SELECT 1 FROM audit_log WHERE entity_type = 'automation_rule' AND entity_ref = $1 AND action = 'tripped'", [`#${noisy.id}`])).rows[0]);
    ok(await pm.put(`/api/rules/${noisy.id}/enabled`, { enabled: true }));
    assert.equal(ok(await pm.get(`/api/rules/${noisy.id}`)).tripped_at, null, 'enabling again clears the trip');
    await disableAll();
  });

  test('a dry run counts what the asker may see and changes nothing', async () => {
    const vip = ok(await pm.post('/api/people', { name: 'Vera Important', email: 'vera@example.com', is_vip: true }), 201);
    const seen = ok(await analyst.post('/api/incidents', { title: 'VIP laptop', caller: { id: vip.id } }), 201);
    const hidden = ok(await analyst.post('/api/incidents', { title: 'VIP mailbox', caller: { id: vip.id } }), 201);
    ok(await analyst.put(`/api/records/${hidden.ref}/visibility`, { restricted: true, reason: 'HR case' }));
    const draft = rule({ name: 'VIP first', conditions: [{ field: 'caller_vip', op: 'is', value: true }], actions: [{ type: 'set_field', field: 'priority', value: 1 }] });
    const auditBefore = (await db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;
    const mine = ok(await analyst.post('/api/rules/dry-run', draft));
    assert.equal(mine.matched, 2, 'the creator sees both');
    const theirs = ok(await analyst2.post('/api/rules/dry-run', draft));
    assert.equal(theirs.matched, 1, 'the restricted one is not counted for others');
    assert.deepEqual(theirs.latest.map((x: any) => x.ref), [seen.ref]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n, auditBefore, 'nothing was changed');
    assert.equal(ok(await analyst.get(`/api/incidents/${seen.ref}`)).priority, seen.priority);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM rule_runs WHERE record_ref = ANY($1)", [[seen.ref, hidden.ref]])).rows[0].n, 0);
  });

  test('notify never tells someone who cannot see the record, and carries no record text', async () => {
    const r = await enabled(rule({ name: 'Tell both', actions: [{ type: 'notify', users: [ids.analyst2], teams: [hr.id] }] }));
    const i = ok(await analyst.post('/api/incidents', { title: 'Payroll export', description: 'SECRET-DETAILS of the case' }), 201);
    ok(await analyst.put(`/api/records/${i.ref}/visibility`, { restricted: true, reason: 'HR case' }));
    ok(await analyst.put(`/api/records/${i.ref}/classification`, { classification: 'confidential', reason: 'Personal data' }));
    await run();
    const sent = (await db.query("SELECT user_id, summary FROM notifications WHERE event = 'automation' AND ref = $1", [i.ref])).rows;
    assert.deepEqual(sent.map((s: any) => s.user_id), [ids.analyst], 'analyst2 cannot see the restricted incident');
    assert.ok(!JSON.stringify(sent).includes('SECRET-DETAILS'));
    const log = ok(await analyst2.get(`/api/rules/${r.id}`));
    assert.ok(!log.runs.some((x: any) => x.record_ref === i.ref), 'the run log hides runs on records the reader cannot see');
    assert.ok(ok(await analyst.get(`/api/rules/${r.id}`)).runs.some((x: any) => x.record_ref === i.ref), 'positive control');
    await disableAll();
  });

  // ---- Part 2: time triggers, recommended rules, the webhook action ----

  const recommended = async (key: string) => (await pm.get('/api/rules')).body.rules.find((r: any) => r.recommended === key);
  const backdate = (table: string, fk: string, ref: string, kind: string, minutes: number) =>
    db.query(`UPDATE ${table} SET created_at = created_at - $3 * interval '1 minute' WHERE ${fk} = (SELECT id FROM ${kind} WHERE ref = $1) AND ($2 = '' OR kind = $2)`, [ref, table.endsWith('activity') ? 'status' : '', minutes]);

  test('time triggers are allowlisted like everything else', async () => {
    assert.equal((await pm.post('/api/rules', rule({ trigger: { type: 'in_status_for', status: 'parked', hours: 2 } }))).status, 400, 'an unknown status');
    assert.equal((await pm.post('/api/rules', rule({ trigger: { type: 'in_status_for', status: 'new', hours: 0.1 } }))).status, 400, 'at least 15 minutes');
    assert.equal((await pm.post('/api/rules', rule({ trigger: { type: 'due_in', hours: 24 } }))).status, 400, 'incidents have no due actions');
    assert.equal((await pm.post('/api/rules', rule({ actions: [{ type: 'notify', roles: ['owner'] }] }))).status, 400, 'the owner only with a due date');
    assert.equal((await pm.post('/api/rules', rule({ actions: [{ type: 'notify', roles: ['approvers'] }] }))).status, 400, 'incidents have no approvers');
    assert.equal((await pm.post('/api/rules', rule({ actions: [{ type: 'webhook', webhook_id: 99999 }] }))).status, 400, 'only a webhook that is set up');
    assert.equal((await pm.post('/api/rules', rule({ actions: [{ type: 'webhook', url: 'https://evil.example' }] }))).status, 400, 'never a URL of its own');
  });

  test('recommended rules ship disabled; closing resolved incidents respects "still a problem" and runs once per window', async () => {
    const rec = (await pm.get('/api/rules')).body.rules.filter((r: any) => r.recommended);
    assert.deepEqual(rec.map((r: any) => r.recommended).sort(), ['close_resolved', 'escalate_p1', 'remind_actions', 'remind_approver']);
    assert.ok(rec.every((r: any) => !r.enabled), 'all off until someone turns them on');
    const close = await recommended('close_resolved');
    ok(await pm.put(`/api/rules/${close.id}/enabled`, { enabled: true }));
    const resolve = async (title: string) => {
      const i = ok(await analyst.post('/api/incidents', { title }), 201);
      ok(await analyst.post(`/api/incidents/${i.ref}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Restarted it' }));
      return i.ref as string;
    };
    const old = await resolve('Resolved a week ago');
    const fresh = await resolve('Resolved just now');
    const reopened = await resolve('Caller said still a problem');
    await backdate('incident_activity', 'incident_id', old, 'incidents', 6 * 24 * 60);
    // The caller said "still a problem" in the portal (#45), and it was resolved again later.
    await db.query(`INSERT INTO incident_activity (incident_id, kind, body, data, channel, created_at)
      SELECT id, 'status', 'The caller says it is still a problem (portal)', '{"from": "resolved", "to": "in_progress", "by_requester": true}', 'portal', now() - interval '8 days' FROM incidents WHERE ref = $1`, [reopened]);
    await backdate('incident_activity', 'incident_id', reopened, 'incidents', 6 * 24 * 60);
    assert.equal(await rules.scanTimeTriggers(), 2, 'the week-old ones, not the fresh one');
    assert.equal(await rules.scanTimeTriggers(), 0, 'a second scan queues nothing: once per record and window');
    await run();
    assert.equal(ok(await analyst.get(`/api/incidents/${old}`)).status, 'closed');
    assert.equal(ok(await analyst.get(`/api/incidents/${fresh}`)).status, 'resolved');
    assert.equal(ok(await analyst.get(`/api/incidents/${reopened}`)).status, 'resolved', 'the caller said it was still a problem: a person closes it');
    assert.equal((await db.query("SELECT status FROM rule_runs WHERE rule_id = $1 AND record_ref = $2", [close.id, reopened])).rows[0].status, 'not_matched');
    await disableAll();
  });

  test('reminders go to the people the record names, once: the action owner and the team lead', async () => {
    const remind = await recommended('remind_actions');
    const escalate = await recommended('escalate_p1');
    ok(await pm.put(`/api/rules/${remind.id}/enabled`, { enabled: true }));
    ok(await pm.put(`/api/rules/${escalate.id}/enabled`, { enabled: true }));
    const p = ok(await analyst.post('/api/problems', { title: 'Backups fail on Sundays' }), 201);
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    ok(await analyst.post(`/api/problems/${p.ref}/actions`, { title: 'Ask the vendor', owner_id: ids.analyst2, due_date: tomorrow }), 201);
    ok(await analyst.post(`/api/problems/${p.ref}/actions`, { title: 'Later', owner_id: ids.analyst2, due_date: new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10) }), 201);
    const p1 = ok(await analyst2.post('/api/incidents', { title: 'Payroll down', impact: 1, urgency: 1, team_id: hr.id }), 201);
    const p1late = ok(await analyst2.post('/api/incidents', { title: 'Payroll slow', impact: 1, urgency: 1, team_id: hr.id }), 201);
    await db.query("UPDATE incidents SET created_at = now() - interval '20 minutes' WHERE ref = $1", [p1late.ref]);
    await rules.scanTimeTriggers();
    await rules.scanTimeTriggers();
    await run();
    const told = (await db.query("SELECT user_id, ref, summary FROM notifications WHERE event = 'automation' AND ref = ANY($1)", [[p.ref, p1.ref, p1late.ref]])).rows;
    assert.deepEqual(told.filter((t: any) => t.ref === p.ref).map((t: any) => t.user_id), [ids.analyst2], 'the owner, once, for the action due tomorrow only');
    assert.match(told.find((t: any) => t.ref === p.ref).summary, new RegExp(`due ${tomorrow}`));
    assert.deepEqual(told.filter((t: any) => t.ref === p1late.ref).map((t: any) => t.user_id), [ids.analyst], 'the lead of HR-Systems after 15 minutes');
    assert.ok(!told.some((t: any) => t.ref === p1.ref), 'not before');
    await disableAll();
  });

  test('the webhook action sends to a configured webhook through the signed outbox, with no record text', async () => {
    const hook = ok(await admin.post('/api/webhooks', { name: 'Chat ops', url: 'https://hooks.example.com/kernel', events: ['problem.created'] }), 201);
    assert.equal((await pm.post('/api/rules', rule({ actions: [{ type: 'webhook', webhook_id: hook.id }], extra: 1 }))).status, 400);
    const listed = ok(await pm.get('/api/rules'));
    assert.deepEqual(listed.webhooks, [{ id: hook.id, name: 'Chat ops' }], 'managers pick from the webhooks by name');
    assert.deepEqual(ok(await analyst.get('/api/rules')).webhooks, [], 'others do not see them');
    await enabled(rule({ name: 'To chat', conditions: [{ field: 'priority', op: 'is', value: 1 }], actions: [{ type: 'webhook', webhook_id: hook.id }] }));
    const open = ok(await analyst.post('/api/incidents', { title: 'Checkout down', description: 'SECRET-TEXT', impact: 1, urgency: 1 }), 201);
    const hidden = ok(await analyst.post('/api/incidents', { title: 'HR breach', impact: 1, urgency: 1 }), 201);
    ok(await analyst.put(`/api/records/${hidden.ref}/visibility`, { restricted: true, reason: 'HR case' }));
    const secret = ok(await analyst.post('/api/incidents', { title: 'Salary file mailed to the wrong person', impact: 1, urgency: 1 }), 201);
    ok(await analyst.put(`/api/records/${secret.ref}/classification`, { classification: 'confidential', reason: 'Personal data' }));
    await run();
    const sent = (await db.query("SELECT payload FROM webhook_deliveries WHERE webhook_id = $1 AND event = 'rule.matched' ORDER BY id", [hook.id])).rows.map((r: any) => r.payload);
    const a = sent.find((x: any) => x.record.ref === open.ref);
    assert.equal(a.record.title, 'Checkout down');
    assert.equal(a.rule.name, 'To chat');
    assert.ok(!JSON.stringify(sent).includes('SECRET-TEXT'));
    const b = sent.find((x: any) => x.record.ref === hidden.ref);
    assert.deepEqual(Object.keys(b.record).sort(), ['classification', 'kind', 'ref', 'restricted', 'url'], 'a restricted record leaves only as its ref');
    const c = sent.find((x: any) => x.record.ref === secret.ref);
    assert.equal(c.record.title, undefined, 'a confidential record leaves without its title (chat is not the place)');
    assert.equal(c.record.classification, 'confidential');
    assert.ok(!JSON.stringify(sent).includes('Salary file'));
    await disableAll();
  });

  test('agents propose rules over MCP; they never enable one', async () => {
    const mcp = new McpClient({ name: 'rules-test', version: '1' });
    const token = await k.tokenFor('pm');
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const res: any = await mcp.callTool({ name, arguments: args });
      return { isError: !!res.isError, data: res.isError ? res.content[0].text : JSON.parse(res.content[0].text) };
    };
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    for (const t of ['list_rules', 'get_rule', 'dry_run_rule', 'propose_rule']) assert.ok(tools.includes(t), t);
    assert.ok(!tools.some((t) => /enable|save_rule/.test(t)), 'no tool enables or writes a rule');
    const draft = { name: 'Agent idea', kind: 'incident', trigger: { type: 'status_changed', to: 'on_hold' }, conditions: [{ field: 'priority', op: 'lt', value: 3 }], actions: [{ type: 'add_comment', text: 'High priority on hold: check the reason' }] };
    const dry = await call('dry_run_rule', { rule: draft });
    assert.equal(dry.isError, false, String(dry.data));
    const proposed = await call('propose_rule', draft);
    assert.equal(proposed.isError, false, String(proposed.data));
    assert.equal(proposed.data.enabled, false);
    assert.equal(proposed.data.proposed_by_agent, true);
    assert.ok((await call('propose_rule', { ...draft, name: 'Sneaky', actions: [{ type: 'set_field', field: 'classification', value: 1 }] })).isError);
    // The same manager's token cannot enable it over REST either: a person enables rules, signed in.
    const api = new Client(k.base, token);
    assert.equal((await api.put(`/api/rules/${proposed.data.id}/enabled`, { enabled: true })).status, 403);
    assert.equal((await api.post('/api/rules', { ...draft, name: 'Via token' })).status, 201, 'a token may write a disabled rule');
    ok(await pm.put(`/api/rules/${proposed.data.id}/enabled`, { enabled: true }));
    await mcp.close();
    await disableAll();
  });
});
