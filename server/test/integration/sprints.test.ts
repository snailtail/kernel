import assert from 'node:assert/strict';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: any }, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const userId = async (username: string) => (await ownerQuery('SELECT id FROM users WHERE username = $1', [username])).rows[0].id as number;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe('sprints, the board, burndown and retrospectives (#166)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, analyst2: Client, viewer: Client;
  let team: { id: number }, kanban: { id: number }, other: { id: number };
  let n = 0;
  const item = async (body: object = {}) => ok(await analyst.post('/api/work-items', { type: 'story', title: `Story ${++n}`, team_id: team.id, ...body }), 201);
  const sprint = async (body: object = {}, teamId = team.id) => ok(await analyst.post('/api/sprints', { team_id: teamId, name: `Sprint ${++n}`, starts_on: day(-2), ends_on: day(2), ...body }), 201);
  const plan = (id: number, body: object) => analyst.post(`/api/sprints/${id}/items`, body);
  const to = (ref: string, status: string) => analyst.post(`/api/work-items/${ref}/transition`, { to: status });

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst, analyst2, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('analyst2'), k.login('viewer')]);
    ok(await admin.put('/api/admin/modules', { development: true, reason: 'Teams build what they run' }));
    team = ok(await admin.post('/api/teams', { name: 'Platform' }), 201);
    kanban = ok(await admin.post('/api/teams', { name: 'Operations' }), 201);
    other = ok(await admin.post('/api/teams', { name: 'Payments' }), 201);
    ok(await admin.put(`/api/teams/${team.id}/members`, { members: [{ user_id: await userId('analyst'), role: 'lead' }] }));
    ok(await admin.put(`/api/teams/${other.id}/members`, { members: [{ user_id: await userId('analyst2') }] }));
  });
  after(async () => k?.close());

  test('the sprint routes, tools and KPI tiles go with the module', async () => {
    const s = await sprint();
    assert.ok((await pm.get('/api/dashboard/kpis')).body.tiles.some((t: any) => t.id === 'points_done'));
    ok(await admin.put('/api/admin/modules', { development: false, reason: 'Off again' }));
    try {
      for (const path of ['/api/sprints', `/api/sprints/${s.id}`, `/api/teams/${team.id}/board`]) assert.equal((await analyst.get(path)).status, 404, path);
      assert.equal((await analyst.post(`/api/sprints/${s.id}/start`, {})).status, 404);
      assert.ok(!(await pm.get('/api/dashboard/kpis')).body.tiles.some((t: any) => ['points_done', 'unplanned_work'].includes(t.id)));
      assert.equal((await analyst.get('/api/meta')).body.work_items, null);
      const mcp = new McpClient({ name: 'sp', version: '1' });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
      const tools = (await mcp.listTools()).tools.map((t) => t.name);
      await mcp.close();
      for (const t of ['list_sprints', 'get_sprint', 'plan_sprint', 'complete_sprint']) assert.ok(!tools.includes(t), t);
    } finally {
      ok(await admin.put('/api/admin/modules', { development: true, reason: 'On' }));
    }
    assert.deepEqual((await analyst.get('/api/meta')).body.work_items.parent_types.task, ['story', 'bug'], 'the hierarchy comes from the server');
    assert.equal((await viewer.post('/api/sprints', { team_id: team.id, name: 'x', starts_on: day(0), ends_on: day(1) })).status, 403);
    assert.equal((await analyst.post('/api/sprints', { team_id: team.id, name: 'x', starts_on: day(1), ends_on: day(0) })).status, 400, 'it ends on or after it starts');
  });

  test('planning: points against capacity, only the team\'s open stories, bugs and tasks, one sprint at a time', async () => {
    const s = await sprint({ capacity: 8, goal: 'Faster login' });
    assert.equal(s.status, 'planned');
    assert.equal(s.next_steps.next, 'Pull items from the top of the backlog');
    const [a, b] = [await item({ points: 5 }), await item({ points: 5 })];
    const planned = ok(await plan(s.id, { add: [a.ref, b.ref] }));
    assert.equal(planned.points.scope, 10);
    assert.equal(planned.points.committed, null, 'nothing is committed before the start');
    assert.ok(planned.over_capacity, 'over capacity is a warning');
    assert.equal(planned.next_steps.next, 'Take something out: the sprint is over capacity');
    assert.deepEqual(planned.work_items.map((w: any) => w.ref), [a.ref, b.ref]);
    assert.equal(ok(await analyst.get(`/api/work-items/${a.ref}`)).sprint.name, s.name);
    assert.ok(ok(await analyst.get(`/api/work-items/${a.ref}`)).activity.some((x: any) => x.kind === 'sprint' && x.body === `Planned into ${s.name}`));

    const epic = await item({ type: 'epic' });
    const elsewhere = ok(await analyst2.post('/api/work-items', { type: 'story', title: 'Elsewhere', team_id: other.id }), 201);
    const finished = await item();
    await to(finished.ref, 'in_progress');
    await to(finished.ref, 'done');
    assert.equal((await plan(s.id, { add: [epic.ref] })).status, 400, 'epics are not planned');
    assert.equal((await plan(s.id, { add: [elsewhere.ref] })).status, 400, "another team's item");
    assert.equal((await plan(s.id, { add: [finished.ref] })).status, 400, 'a done item');
    assert.equal((await plan(s.id, { add: ['WI999999'] })).status, 400);
    const s2 = await sprint();
    assert.equal((await plan(s2.id, { add: [a.ref] })).status, 409, 'an item is in one sprint at a time');
    assert.deepEqual(ok(await analyst.get(`/api/work-items?team=${team.id}&sprint=none`)).map((w: any) => w.ref).filter((r: string) => [a.ref, b.ref].includes(r)), [], 'left to plan');

    const out = ok(await plan(s.id, { remove: [b.ref] }));
    assert.equal(out.points.scope, 5);
    assert.ok(!out.over_capacity);
    assert.equal(ok(await analyst.get(`/api/work-items/${b.ref}`)).sprint, null, 'back to the backlog');
    ok(await analyst.patch(`/api/sprints/${s.id}`, { capacity: 13, goal: 'Faster login, measured' }));
    assert.equal(ok(await analyst.get(`/api/sprints/${s.id}`)).capacity, 13);
  });

  test('one active sprint per team; added after the start is unplanned', async () => {
    const t = ok(await admin.post('/api/teams', { name: 'Search' }), 201);
    const s = await sprint({}, t.id);
    const s2 = await sprint({}, t.id);
    const a = ok(await analyst.post('/api/work-items', { type: 'story', title: 'Planned', team_id: t.id, points: 3 }), 201);
    ok(await plan(s.id, { add: [a.ref] }));
    const started = ok(await analyst.post(`/api/sprints/${s.id}/start`, {}));
    assert.equal(started.status, 'active');
    assert.equal(started.points.committed, 3);
    const second = await analyst.post(`/api/sprints/${s2.id}/start`, {});
    assert.equal(second.status, 409);
    assert.match(second.body.error ?? second.body.message, /already has an active sprint/);
    assert.equal((await analyst.post(`/api/sprints/${s.id}/start`, {})).status, 409);

    const late = ok(await analyst.post('/api/work-items', { type: 'bug', title: 'Prod fire', team_id: t.id, points: 2 }), 201);
    const after = ok(await plan(s.id, { add: [late.ref] }));
    assert.equal(after.work_items.find((w: any) => w.ref === late.ref).unplanned, true);
    assert.equal(after.points.committed, 3, 'the commitment does not grow');
    assert.equal(after.points.unplanned, 2);
    assert.equal(after.points.unplanned_share, 40);
    assert.ok(ok(await analyst.get(`/api/work-items/${late.ref}`)).activity.some((x: any) => x.body === `Added to ${s.name} after it started`));
  });

  test('completing: done stays, unfinished goes to the backlog by default or on to the next sprint, logged; the numbers are kept', async () => {
    const t = ok(await admin.post('/api/teams', { name: 'Identity' }), 201);
    const mk = async (title: string, points: number) => ok(await analyst.post('/api/work-items', { type: 'story', title, team_id: t.id, points }), 201);
    const [done, stay, carry] = [await mk('Done', 5), await mk('Back', 3), await mk('Carry', 2)];
    const s = await sprint({}, t.id);
    ok(await plan(s.id, { add: [done.ref, stay.ref, carry.ref] }));
    ok(await analyst.post(`/api/sprints/${s.id}/start`, {}));
    await to(done.ref, 'in_progress');
    await to(done.ref, 'done');
    await to(stay.ref, 'in_progress');
    assert.equal((await analyst.post(`/api/sprints/${s.id}/complete`, { unfinished: { [carry.ref]: 'next_sprint' } })).status, 400, 'no next sprint planned yet');
    assert.equal((await analyst.post(`/api/sprints/${s.id}/complete`, { unfinished: { [done.ref]: 'backlog' } })).status, 400, 'only unfinished items choose');
    const next = await sprint({ starts_on: day(3), ends_on: day(10) }, t.id);
    const completed = ok(await analyst.post(`/api/sprints/${s.id}/complete`, { unfinished: { [carry.ref]: 'next_sprint' } }));
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.points, { committed: 10, scope: 10, completed: 5, left: 5, unplanned: 0, unplanned_share: 0 });
    assert.deepEqual(Object.fromEntries(completed.work_items.map((w: any) => [w.ref, w.outcome])), { [done.ref]: 'done', [stay.ref]: 'backlog', [carry.ref]: 'next_sprint' });
    assert.equal(ok(await analyst.get(`/api/work-items/${done.ref}`)).sprint.name, s.name, 'a done item keeps its sprint');
    assert.equal(ok(await analyst.get(`/api/work-items/${stay.ref}`)).sprint, null);
    const carried = ok(await analyst.get(`/api/work-items/${carry.ref}`));
    assert.equal(carried.sprint.name, next.name);
    assert.ok(carried.activity.some((x: any) => x.body === `Unfinished when ${s.name} was completed: on to ${next.name}`));
    assert.ok(ok(await analyst.get(`/api/work-items/${stay.ref}`)).activity.some((x: any) => x.body === `Unfinished when ${s.name} was completed: back to the backlog`));
    assert.deepEqual(ok(await analyst.get(`/api/sprints/${next.id}`)).work_items.map((w: any) => w.ref), [carry.ref]);
    assert.equal((await analyst.post(`/api/sprints/${s.id}/complete`, {})).status, 409);
    assert.equal((await analyst.patch(`/api/sprints/${s.id}`, { ends_on: day(5) })).status, 409, 'a completed sprint keeps its dates');
    ok(await analyst.patch(`/api/sprints/${s.id}`, { review_notes: 'Demoed the login flow' }));

    // Reopening and re-estimating later does not move a completed sprint's numbers.
    await to(done.ref, 'in_progress');
    ok(await analyst.patch(`/api/work-items/${done.ref}`, { points: 13 }));
    const kept = ok(await analyst.get(`/api/sprints/${s.id}`));
    assert.equal(kept.points.completed, 5);
    assert.equal(kept.points.scope, 10);
    assert.equal(kept.velocity.sprints.at(-1).completed, 5);
    assert.equal(kept.review_notes, 'Demoed the login flow');
    const log = await ownerQuery("SELECT action FROM audit_log WHERE entity_type = 'sprint' AND entity_ref = $1 ORDER BY id", [String(s.id)]);
    assert.deepEqual(log.rows.map((r: any) => r.action), ['create', 'start', 'complete', 'update']);
  });

  test('the burndown: points left per day up to today against the ideal line, and the velocity of the last sprints', async () => {
    const t = ok(await admin.post('/api/teams', { name: 'Billing' }), 201);
    const mk = async (points: number) => ok(await analyst.post('/api/work-items', { type: 'story', title: `B${points}`, team_id: t.id, points }), 201);
    const [a, b, c] = [await mk(5), await mk(3), await mk(2)];
    const s = await sprint({ starts_on: day(-2), ends_on: day(2) }, t.id);
    assert.equal(s.burndown, null, 'none before the start');
    ok(await plan(s.id, { add: [a.ref, b.ref] }));
    ok(await analyst.post(`/api/sprints/${s.id}/start`, {}));
    // As if planned before the first day, with a finished yesterday and c added today.
    await ownerQuery('UPDATE sprint_items SET added_at = $2::date - 1 WHERE sprint_id = $1', [s.id, day(-2)]);
    await to(a.ref, 'in_progress');
    await to(a.ref, 'done');
    await ownerQuery("UPDATE work_items SET done_at = $2::date + interval '12 hours' WHERE ref = $1", [a.ref, day(-1)]);
    ok(await plan(s.id, { add: [c.ref] }));
    const got = ok(await analyst.get(`/api/sprints/${s.id}`));
    assert.deepEqual(got.burndown.map((d: any) => d.day), [day(-2), day(-1), day(0), day(1), day(2)]);
    assert.deepEqual(got.burndown.map((d: any) => d.left), [8, 3, 5, null, null], 'today counts the unplanned bug');
    assert.deepEqual(got.burndown.map((d: any) => d.ideal), [8, 6, 4, 2, 0]);
    assert.equal(got.points.unplanned_share, 20);

    // Velocity: committed against completed, oldest first, for the last six completed sprints.
    ok(await analyst.post(`/api/sprints/${s.id}/complete`, {}));
    const s2 = await sprint({ starts_on: day(3), ends_on: day(9) }, t.id);
    ok(await plan(s2.id, { add: [b.ref] }));
    ok(await analyst.post(`/api/sprints/${s2.id}/start`, {}));
    await to(b.ref, 'in_progress');
    await to(b.ref, 'done');
    const v = ok(await analyst.post(`/api/sprints/${s2.id}/complete`, {})).velocity;
    assert.deepEqual(v.sprints.map((x: any) => [x.name, x.committed, x.completed]), [[s.name, 8, 5], [s2.name, 3, 3]]);
    assert.equal(v.average, 4);
    const listed = ok(await analyst.get(`/api/sprints?team=${t.id}&status=completed`));
    assert.deepEqual(listed.map((x: any) => x.id), [s2.id, s.id]);
    const tiles = ok(await pm.get('/api/dashboard/kpis?period=week')).tiles;
    assert.ok(tiles.find((x: any) => x.id === 'points_done').value >= 3);
    assert.ok(tiles.some((x: any) => x.id === 'unplanned_work'));
  });

  test('the board: the active sprint in status columns, or a Kanban team\'s open items with WIP limits as a warning', async () => {
    const s = ok(await analyst.get(`/api/sprints?team=${team.id}&status=planned`)).find((x: any) => x.items.total > 0);
    ok(await analyst.post(`/api/sprints/${s.id}/start`, {}));
    const board = ok(await viewer.get(`/api/teams/${team.id}/board`));
    assert.equal(board.sprint.id, s.id);
    assert.deepEqual(board.columns.map((c: any) => c.status), ['new', 'ready', 'in_progress', 'in_review', 'done']);
    const inSprint = ok(await analyst.get(`/api/sprints/${s.id}`)).work_items.map((w: any) => w.ref).sort();
    assert.deepEqual(board.columns.flatMap((c: any) => c.items.map((w: any) => w.ref)).sort(), inSprint, 'only the sprint\'s items');
    const card = board.columns.find((c: any) => c.items.length).items[0];
    assert.ok(Array.isArray(card.transitions) && card.url.endsWith(`/work/${card.ref}`));

    const mk = async (title: string) => ok(await analyst.post('/api/work-items', { type: 'task', title, team_id: kanban.id }), 201);
    const tasks = [await mk('K1'), await mk('K2'), await mk('K3')];
    for (const w of tasks) await to(w.ref, 'in_progress');
    assert.equal((await analyst.put(`/api/teams/${kanban.id}/work-definitions`, { ready: [], done: [], wip_limits: { in_progress: 2 } })).status, 403);
    ok(await pm.put(`/api/teams/${kanban.id}/work-definitions`, { ready: [], done: [], wip_limits: { in_progress: 2 } }));
    assert.equal((await pm.put(`/api/teams/${kanban.id}/work-definitions`, { ready: [], done: [], wip_limits: { removed: 2 } })).status, 400);
    const kb = ok(await viewer.get(`/api/teams/${kanban.id}/board`));
    assert.equal(kb.sprint, null);
    const wip = kb.columns.find((c: any) => c.status === 'in_progress');
    assert.equal(wip.wip_limit, 2);
    assert.equal(wip.over_limit, true, 'a warning, not a block');
    assert.equal(wip.items.length, 3);
    assert.equal(ok(await viewer.get(`/api/teams/${kanban.id}/board?assignee=none&type=story`)).columns.flatMap((c: any) => c.items).length, 0, 'filters');
    assert.deepEqual(ok(await analyst.get(`/api/teams/${kanban.id}/work-definitions`)).wip_limits, { in_progress: 2 });
    ok(await pm.put(`/api/teams/${kanban.id}/work-definitions`, { ready: ['Estimated'], done: [] }));
    assert.deepEqual(ok(await analyst.get(`/api/teams/${kanban.id}/work-definitions`)).wip_limits, { in_progress: 2 }, 'kept when left out');
  });

  test('an item leaves its sprint when it moves to another team or is removed', async () => {
    const s = ok(await analyst.get(`/api/sprints?team=${team.id}&status=active`))[0];
    const [moved, removed] = [await item({ points: 1 }), await item({ points: 1 })];
    ok(await plan(s.id, { add: [moved.ref, removed.ref] }));
    const w = ok(await pm.patch(`/api/work-items/${moved.ref}`, { team_id: other.id }));
    assert.equal(w.sprint, null);
    assert.ok(w.activity.some((x: any) => x.kind === 'sprint' && /another team/.test(x.body)));
    const r = ok(await analyst.post(`/api/work-items/${removed.ref}/transition`, { to: 'removed', reason: 'Not needed' }));
    assert.equal(r.sprint, null);
    assert.ok(!ok(await analyst.get(`/api/sprints/${s.id}`)).work_items.some((x: any) => [moved.ref, removed.ref].includes(x.ref)));
  });

  test('retrospective: went well, hard, to change; a change becomes an improvement with one click', async () => {
    const s = ok(await analyst.get(`/api/sprints?team=${team.id}&status=active`))[0];
    const planned = await sprint();
    assert.equal((await analyst.post(`/api/sprints/${planned.id}/retro`, { kind: 'hard', body: 'x' })).status, 409, 'it opens with the start');
    ok(await analyst.post(`/api/sprints/${s.id}/retro`, { kind: 'went_well', body: 'Pairing on the login flow' }));
    ok(await analyst2.post(`/api/sprints/${s.id}/retro`, { kind: 'hard', body: 'Flaky staging' }));
    const r = ok(await analyst.post(`/api/sprints/${s.id}/retro`, { kind: 'to_change', body: 'Automate the staging reset\nIt took a day every sprint.' }));
    assert.deepEqual(r.retrospective.map((x: any) => x.kind), ['went_well', 'hard', 'to_change']);
    const [well, hard, change] = r.retrospective;
    assert.equal((await analyst.post(`/api/sprints/${s.id}/retro/${well.id}/improvement`, {})).status, 400, 'only a change');
    assert.equal((await viewer.post(`/api/sprints/${s.id}/retro/${change.id}/improvement`, {})).status, 403);
    const after = ok(await analyst.post(`/api/sprints/${s.id}/retro/${change.id}/improvement`, { owner_id: await userId('analyst') }));
    const imp = after.retrospective.find((x: any) => x.id === change.id).improvement;
    assert.match(imp, /^IMP\d{6}$/);
    const m = ok(await analyst.get(`/api/improvements/${imp}`));
    assert.equal(m.source, 'retrospective');
    assert.equal(m.restricted, false, 'without team scoping it starts broad');
    assert.equal((await analyst2.get(`/api/improvements/${imp}`)).status, 200);
    assert.equal(m.title, 'Automate the staging reset');
    assert.match(m.description, new RegExp(`retrospective of ${s.name} \\(Platform\\)`));
    assert.ok(ok(await analyst.get('/api/improvements?source=retrospective')).some((x: any) => x.ref === imp));
    assert.equal((await analyst.post(`/api/sprints/${s.id}/retro/${change.id}/improvement`, {})).status, 409, 'once');
    assert.equal((await analyst.del(`/api/sprints/${s.id}/retro/${change.id}`)).status, 409, 'its source stays');
    assert.equal((await analyst.del(`/api/sprints/${s.id}/retro/${hard.id}`)).status, 403, "someone else's");
    ok(await pm.del(`/api/sprints/${s.id}/retro/${hard.id}`));
    ok(await analyst.del(`/api/sprints/${s.id}/retro/${well.id}`));
    assert.equal(ok(await analyst.get(`/api/sprints/${s.id}`)).retrospective.length, 1);
  });

  test('team scoping: a team\'s sprints are its own when work items are team-scoped', async () => {
    const s = ok(await analyst.get(`/api/sprints?team=${team.id}&status=active`))[0];
    ok(await admin.put('/api/admin/visibility', { team_scoped: { incident: false, problem: false, change: false, work_item: true }, restricted_categories: [], reason: 'Teams work separately' }));
    try {
      assert.equal((await analyst2.get(`/api/sprints/${s.id}`)).status, 404);
      assert.ok(!ok(await analyst2.get('/api/sprints')).some((x: any) => x.id === s.id));
      assert.equal((await analyst2.post(`/api/sprints/${s.id}/complete`, {})).status, 404);
      assert.equal((await analyst.get(`/api/sprints/${s.id}`)).status, 200, 'the team sees it');
      assert.equal((await pm.get(`/api/sprints/${s.id}`)).status, 200, 'managers are not team-scoped');
      // The retrospective is the team's now, so an improvement from it starts restricted to the team (#158).
      const r = ok(await analyst.post(`/api/sprints/${s.id}/retro`, { kind: 'to_change', body: 'Team-only lesson about the vault' }));
      const item = r.retrospective.find((x: any) => x.body === 'Team-only lesson about the vault');
      const imp = ok(await analyst.post(`/api/sprints/${s.id}/retro/${item.id}/improvement`, {})).retrospective.find((x: any) => x.id === item.id).improvement;
      const m = ok(await analyst.get(`/api/improvements/${imp}`));
      assert.equal(m.restricted, true);
      assert.deepEqual(m.restricted_teams, [team.id]);
      assert.equal((await analyst2.get(`/api/improvements/${imp}`)).status, 404, 'outside the team it is not there');
      assert.ok(!JSON.stringify(ok(await analyst2.get('/api/improvements?status=all'))).includes('vault'));
    } finally {
      ok(await admin.put('/api/admin/visibility', { team_scoped: { incident: false, problem: false, change: false, work_item: false }, restricted_categories: [], reason: 'Back to shared' }));
    }
  });

  test('MCP: plan, start, read and complete a sprint', async () => {
    const t = ok(await admin.post('/api/teams', { name: 'Mobile' }), 201);
    const w = ok(await analyst.post('/api/work-items', { type: 'story', title: 'Offline mode <b>', team_id: t.id, points: 3 }), 201);
    const mcp = new McpClient({ name: 'sp', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const call = async (name: string, args: object) => {
      const r: any = await mcp.callTool({ name, arguments: args });
      assert.ok(!r.isError, JSON.stringify(r.content));
      return JSON.parse(r.content[0].text);
    };
    try {
      const planned = await call('plan_sprint', { team_id: t.id, name: 'M1', goal: 'Works on the train', starts_on: day(0), ends_on: day(13), capacity: 5, add: [w.ref], start: true });
      assert.equal(planned.status, 'active');
      assert.equal(planned.points.committed, 3);
      assert.equal(planned.untrusted_content.item_titles[w.ref], 'Offline mode <b>');
      assert.equal(planned.untrusted_content.goal, 'Works on the train');
      assert.equal(planned.burndown.length, 14);
      const listed = await call('list_sprints', { team: t.id });
      assert.equal(listed[0].sprint_id, planned.sprint_id);
      assert.equal((await call('get_sprint', { sprint_id: planned.sprint_id })).work_items[0].ref, w.ref);
      const done = await call('complete_sprint', { sprint_id: planned.sprint_id, unfinished: { [w.ref]: 'backlog' } });
      assert.equal(done.status, 'completed');
      assert.equal(done.work_items[0].outcome, 'backlog');
    } finally {
      await mcp.close();
    }
  });
});
