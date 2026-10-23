import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('modules and first-run setup (#36)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;

  before(async () => {
    process.env.KERNEL_SECRET_KEY = 'modules-test-key-0123456789abcdefghijklm';
    k = await startKernel();
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
  });
  after(async () => {
    delete process.env.KERNEL_SECRET_KEY;
    await k?.close();
  });

  test('a fresh installation offers the setup wizard; it is idempotent and demo data is removable', async () => {
    assert.equal((await analyst.get('/api/meta')).body.setup_completed, false);
    assert.equal((await pm.post('/api/setup', {})).status, 403, 'administrators only');
    const first = (await admin.post('/api/setup', { support_hours: 'office', first_source: { kind: 'uptime_kuma', name: 'Kuma' }, demo_data: true })).body;
    assert.equal(first.completed, true);
    assert.match(first.result.first_source.token, /^kernel_evt_/);
    assert.equal(first.result.demo.loaded, true);
    assert.equal(first.demo_records, 6);
    const again = (await admin.post('/api/setup', { support_hours: 'office', first_source: { kind: 'uptime_kuma', name: 'Kuma' }, demo_data: true })).body;
    assert.equal(again.result.first_source.existing, true, 'no duplicate source');
    assert.equal(again.result.demo.loaded, false, 'no duplicate demo data');
    assert.equal((await admin.get('/api/event-sources')).body.length, 1);
    assert.equal((await admin.get('/api/slas')).body.filter((s: any) => s.is_default)[0].calendar, 'Office hours (Sweden)');
    // A real incident linked to the demo problem: removal waits for confirmation and leaves a history entry.
    const demoProblem = again.result ? (await admin.get('/api/problems?q=demo&status=all')).body[0].ref : '';
    const real = (await analyst.post('/api/incidents', { title: 'Real incident' })).body.ref;
    await analyst.put(`/api/incidents/${real}/problem`, { problem: demoProblem });
    const blocked = await admin.post('/api/setup/demo/remove', {});
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.body.references.map((r: any) => [r.ref, r.demo_ref]), [[real, demoProblem]]);
    assert.equal((await admin.get('/api/setup')).body.demo_references.length, 1, 'shown before removal');
    const removed = (await admin.post('/api/setup/demo/remove', { confirm: true })).body.removed;
    assert.deepEqual(removed, { change: 1, incident: 1, problem: 1, ci: 3 });
    const after = (await analyst.get(`/api/incidents/${real}`)).body;
    assert.equal(after.problem_ref, null);
    assert.ok(after.activity.some((a: any) => a.body === `Unlinked ${demoProblem}: demo data removed`));
    await analyst.post('/api/problems', { title: 'A real problem' });
    assert.equal((await admin.post('/api/setup', { demo_data: true })).status, 409, 'never mixed with real data');
    const audit = (await admin.get('/api/audit?entity_type=setting')).body;
    assert.ok(audit.some((e: any) => e.entity_ref === 'setup' && e.action === 'complete'));
  });

  test('a switched-off module is gone everywhere and comes back unchanged', async () => {
    const inc = (await analyst.post('/api/incidents', { title: 'Before switching off' })).body;
    assert.equal((await pm.put('/api/admin/modules', { incident: false })).status, 403);
    const mods = (await admin.put('/api/admin/modules', { incident: false, reason: 'We use ServiceNow for incidents' })).body;
    assert.equal(mods.find((m: any) => m.key === 'incident').enabled, false);
    const gone = await analyst.get('/api/incidents');
    assert.equal(gone.status, 404);
    assert.match(gone.body.error, /Incidents module is turned off/);
    assert.equal((await analyst.get(`/api/incidents/${inc.ref}`)).status, 404);
    assert.equal((await analyst.get(`/api/records/${inc.ref}`)).status, 404);
    assert.equal((await analyst.get(`/api/records/${inc.ref}/history`)).status, 404);
    assert.equal((await analyst.get('/api/reviews')).status, 404, 'post-incident reviews belong to the incidents module');
    assert.ok(!(await analyst.get('/api/search?q=switching')).body.some((h: any) => h.type === 'incident'));
    const openapi = (await analyst.get('/api/openapi.json')).body;
    assert.equal(openapi.paths['/api/incidents'], undefined);
    assert.ok(openapi.paths['/api/problems']);
    assert.equal((await analyst.get('/api/reports')).body.incidents, null);
    assert.equal((await analyst.get('/api/meta')).body.modules.incident, false);
    const mcp = new McpClient({ name: 'mods', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    assert.ok(!tools.includes('create_incident') && !tools.includes('list_incidents'));
    assert.ok(!tools.includes('get_review') && !tools.includes('transition_review'));
    assert.ok(tools.includes('create_problem'));
    assert.ok(!(await mcp.listPrompts()).prompts.some((p) => p.name === 'triage_incident'));
    await mcp.close();
    // Rules do not open incidents while incidents are off; the alert is still recorded.
    await pm.post('/api/event-rules', { name: 'All', conditions: {} });
    const ev = (await analyst.post('/api/events', { source: 'mod', events: [{ host: 'h1', check: 'ping', severity: 'critical' }] })).body;
    assert.equal(ev.results[0].outcome, 'opened');
    await admin.put('/api/admin/modules', { incident: true, reason: 'Back on' });
    assert.equal((await analyst.get(`/api/incidents/${inc.ref}`)).body.title, 'Before switching off', 'nothing was deleted');
  });

  test('problem management can be switched off (#184): its routes and tools go, actions and reviews stay', async () => {
    const prb = (await analyst.post('/api/problems', { title: 'Problems before switching off' })).body.ref;
    const inc = (await analyst.post('/api/incidents', { title: 'An incident with a review' })).body.ref;
    const pir = (await pm.post(`/api/incidents/${inc}/review`, {})).body.ref;
    const mods = (await admin.put('/api/admin/modules', { problem: false, reason: 'Problems live in another tool' })).body;
    assert.equal(mods.find((m: any) => m.key === 'problem').enabled, false);
    try {
      for (const path of ['/api/problems', `/api/problems/${prb}`, `/api/records/${prb}`, '/api/kedb', '/api/candidates', '/api/review', '/api/reports/problems.csv']) {
        assert.equal((await analyst.get(path)).status, 404, path);
      }
      assert.equal((await analyst.post('/api/problems', { title: 'x' })).status, 404);
      assert.equal((await analyst.post(`/api/problems/${prb}/actions`, { title: 'x' })).status, 404);
      assert.ok(!(await analyst.get('/api/search?q=switching')).body.some((h: any) => h.type === 'problem'));
      assert.equal((await analyst.get('/api/meta')).body.modules.problem, false);
      assert.deepEqual((await analyst.get('/api/dashboard')).body, { problems: false }, 'the dashboard stays, without the backlog');
      const report = (await analyst.get('/api/reports')).body;
      assert.equal(report.problems, false);
      assert.equal(report.summary, undefined, 'no problem sections');
      assert.ok(!(await analyst.get('/api/dashboard/kpis?period=month')).body.tiles.some((t: any) => ['problems_resolved', 'recurring'].includes(t.id)));
      const openapi = (await analyst.get('/api/openapi.json')).body;
      assert.equal(openapi.paths['/api/problems'], undefined);
      assert.ok(openapi.paths['/api/actions']);

      // The actions register, My Work and the post-incident review keep working.
      const action = await analyst.post('/api/actions', { parent: inc, title: 'Document the restart' });
      assert.equal(action.status, 201, JSON.stringify(action.body));
      assert.ok((await analyst.get('/api/actions?status=all')).body.some((a: any) => a.id === action.body.id));
      const work = await analyst.get('/api/my-work');
      assert.equal(work.status, 200);
      assert.deepEqual(work.body.problems, []);
      let r = (await analyst.post(`/api/incidents/${inc}/review/items`, { kind: 'follow_up', body: 'Add a restart runbook' })).body;
      const item = r.items.find((x: any) => x.kind === 'follow_up');
      r = (await analyst.post(`/api/incidents/${inc}/review/items/${item.id}/action`, {})).body;
      assert.deepEqual(r.actions.map((a: any) => [a.ref, a.title]), [[pir, 'Add a restart runbook']]);
      r = (await analyst.post(`/api/incidents/${inc}/review/items`, { kind: 'factor', body: 'No runbook' })).body;
      const factor = r.items.find((x: any) => x.kind === 'factor');
      assert.equal((await analyst.post(`/api/incidents/${inc}/review/items/${factor.id}/problem`, {})).status, 404, 'no problem from a factor');
      assert.equal((await analyst.post(`/api/incidents/${inc}/review/items/${item.id}/action`, { problem: prb })).status, 409, 'already an action');
      assert.equal((await analyst.get(`/api/incidents/${inc}`)).body.next_steps.handover, null, 'no hand-over to problem management');

      const mcp = new McpClient({ name: 'mods', version: '1' });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
      const tools = (await mcp.listTools()).tools.map((t) => t.name);
      for (const gone of ['create_problem', 'search_problems', 'get_problem', 'search_known_errors', 'list_problem_candidates', 'get_review_agenda', 'start_analysis']) {
        assert.ok(!tools.includes(gone), `${gone} is listed`);
      }
      for (const kept of ['add_action', 'list_actions', 'update_action', 'my_work', 'add_comment', 'link_records', 'get_review', 'create_incident', 'get_dashboard', 'get_report']) {
        assert.ok(tools.includes(kept), `${kept} is missing`);
      }
      assert.ok(!(await mcp.listPrompts()).prompts.some((p) => p.name === 'five_whys' || p.name === 'problem_review_board'));
      const dash: any = await mcp.callTool({ name: 'get_dashboard', arguments: {} });
      const board = JSON.parse(dash.content[0].text);
      assert.ok(!dash.isError && Array.isArray(board.kpis.tiles), 'the KPIs are there');
      assert.equal(board.by_status, undefined, 'without the problem backlog');
      assert.equal(board.problems, false);
      await mcp.close();
    } finally {
      await admin.put('/api/admin/modules', { problem: true, reason: 'Back on' });
    }
    assert.equal((await analyst.get(`/api/problems/${prb}`)).body.title, 'Problems before switching off', 'nothing was deleted');
  });

  test('event hooks answer 503 while events are off; the CMDB can be switched off too', async () => {
    const src = (await admin.get('/api/event-sources')).body[0];
    const token = (await admin.post(`/api/event-sources/${src.id}/rotate`, {})).body.token;
    await admin.put('/api/admin/modules', { event: false, cmdb: false, reason: 'Testing' });
    const hook = await new Client(k.base).request('POST', `/api/event-hooks/${src.id}`, { heartbeat: null, monitor: null, msg: 'test' }, { Authorization: `Bearer ${token}` });
    assert.equal(hook.status, 503);
    assert.match(hook.body.error, /events module is turned off/);
    assert.equal((await analyst.get('/api/cis')).status, 404);
    assert.equal((await analyst.get('/api/alerts')).status, 404);
    await admin.put('/api/admin/modules', { event: true, cmdb: true, reason: 'Done' });
    assert.equal((await analyst.get('/api/cis')).status, 200);
  });

  test('templates prefill new incidents and problems', async () => {
    assert.equal((await analyst.post('/api/templates', { kind: 'incident', name: 'x', fields: {} })).status, 403);
    const t = await pm.post('/api/templates', { kind: 'incident', name: 'Printer jam', fields: { title: 'Printer jammed', impact: 3, urgency: 3, assignment_group: 'Desk' } });
    assert.equal(t.status, 201);
    assert.equal((await analyst.get('/api/templates?kind=incident')).body[0].fields.assignment_group, 'Desk');
  });
});
