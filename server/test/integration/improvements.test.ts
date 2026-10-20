import assert from 'node:assert/strict';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: unknown }) => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);
const userId = async (username: string) => (await ownerQuery('SELECT id FROM users WHERE username = $1', [username])).rows[0].id as number;

describe('continual improvement register (#52)', { skip }, () => {
  let k: Harness;
  let pm: Client, analyst: Client, analyst2: Client, viewer: Client;
  let service = '';

  before(async () => {
    k = await startKernel();
    [pm, analyst, analyst2, viewer] = await Promise.all([k.login('pm'), k.login('analyst'), k.login('analyst2'), k.login('viewer')]);
    service = (await pm.post('/api/cis', { name: 'Payroll', ci_type: 'business_service' })).body.ref;
  });
  after(async () => k?.close());

  test('anyone who works on problems suggests one; viewers read; it starts as an idea with guidance', async () => {
    assert.equal((await viewer.post('/api/improvements', { title: 'Nope' })).status, 403);
    const r = await analyst.post('/api/improvements', { title: 'Automate certificate renewal', description: 'Three outages from expired certificates this year.', service, value: 5, effort: 1, kpi: 'mttr' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.ref, /^IMP\d{6}$/);
    assert.equal(r.body.status, 'idea');
    assert.equal(r.body.source, 'idea');
    assert.equal(r.body.service.ref, service);
    assert.equal(r.body.next_steps.phase, 'Idea');
    assert.equal(r.body.next_steps.next, 'A manager approves or rejects it');
    assert.deepEqual(r.body.transitions, [], 'deciding is for managers');
    assert.equal(r.body.kpi_tile.id, 'mttr', 'the linked KPI comes with its trend');
    assert.equal(r.body.kpi_tile.trend.length, 6);
    assert.equal((await viewer.get(`/api/improvements/${r.body.ref}`)).status, 200);
    assert.equal((await analyst.post('/api/improvements', { title: 'Bad', kpi: 'nonsense' })).status, 400);
    assert.equal((await analyst.post('/api/improvements', { title: 'Bad', value: 6 })).status, 400);
    assert.equal((await analyst.post('/api/improvements', { title: 'Bad', service: 'CI999999' })).status, 400);

    ok(await analyst.post('/api/improvements', { title: 'Rewrite the whole CMDB', value: 2, effort: 5 }));
    const quick = (await viewer.get('/api/improvements?quick_wins=true')).body.map((m: any) => m.ref);
    assert.ok(quick.includes(r.body.ref));
    assert.ok(!(await viewer.get('/api/improvements?quick_wins=true')).body.some((m: any) => m.title === 'Rewrite the whole CMDB'));
    assert.ok((await viewer.get(`/api/improvements?service=${service}`)).body.every((m: any) => m.service_ref === service));
    assert.ok((await viewer.get('/api/improvements?q=certificate')).body.some((m: any) => m.ref === r.body.ref));
    const views = (await viewer.get('/api/views?list=improvements')).body.views.map((v: any) => v.name);
    assert.ok(views.includes('Quick wins'));
  });

  test('a manager approves or rejects with a reason; done needs the benefit; every step is in the history', async () => {
    const ref = (await analyst.post('/api/improvements', { title: 'Self-service password reset' })).body.ref;
    const go = (c: Client, body: object) => c.post(`/api/improvements/${ref}/transition`, body);
    assert.equal((await go(analyst, { to: 'approved' })).status, 403);
    assert.equal((await go(analyst, { to: 'done' })).status, 409, 'not straight from idea to done');
    const approved = await go(pm, { to: 'approved' });
    ok(approved);
    assert.equal(approved.body.decided_by_name, 'Pm');
    ok(await analyst.patch(`/api/improvements/${ref}`, { owner_id: await userId('analyst') }));
    assert.equal((await go(analyst, { to: 'in_progress' })).body.status, 'in_progress');
    const noBenefit = await go(analyst, { to: 'done' });
    assert.equal(noBenefit.status, 400);
    assert.match(noBenefit.body.error, /benefit/);
    const done = await go(analyst, { to: 'done', benefit: 'Password tickets down 40 % in a month' });
    assert.equal(done.body.status, 'done');
    assert.ok(done.body.done_at);
    assert.equal(done.body.next_steps.phase, 'Done');
    assert.equal((await analyst.patch(`/api/improvements/${ref}`, { benefit: '' })).status, 400, 'a done improvement keeps its benefit');

    const other = (await analyst.post('/api/improvements', { title: 'Buy a bigger server' })).body.ref;
    assert.equal((await pm.post(`/api/improvements/${other}/transition`, { to: 'rejected' })).status, 400, 'rejecting needs a reason');
    const rejected = (await pm.post(`/api/improvements/${other}/transition`, { to: 'rejected', reason: 'Capacity is fine; the slowness was a query' })).body;
    assert.equal(rejected.reject_reason, 'Capacity is fine; the slowness was a query');
    const history = (await analyst.get(`/api/records/${ref}/history`)).body.map((e: any) => e.action);
    for (const a of ['created', 'status', 'update']) assert.ok(history.includes(a), `history has ${a}: ${history}`);
    const notes = await ownerQuery("SELECT count(*)::int AS n FROM notifications WHERE ref = $1 AND user_id = $2", [ref, await userId('analyst')]);
    assert.ok(notes.rows[0].n >= 1, 'the owner hears about the decision');
  });

  test('links: changes, problems and actions that carry it out, from either side', async () => {
    const ref = (await analyst.post('/api/improvements', { title: 'Canary deploys for the webshop' })).body.ref;
    const chg = (await analyst.post('/api/changes', { title: 'Add canary stage' })).body.ref;
    const prb = (await analyst.post('/api/problems', { title: 'Deploys break checkout' })).body.ref;
    ok(await analyst.post(`/api/problems/${prb}/actions`, { title: 'Write the canary runbook' }));
    const actionId = (await ownerQuery("SELECT a.id FROM problem_actions a JOIN problems p ON p.id = a.problem_id WHERE p.ref = $1", [prb])).rows[0].id;
    ok(await analyst.post(`/api/improvements/${ref}/links`, { kind: 'change', reference: chg }));
    ok(await analyst.post(`/api/records/${ref}/links`, { to: String(actionId), kind: 'action' }));
    ok(await analyst.post(`/api/records/${prb}/links`, { to: ref }));
    const m = (await analyst.get(`/api/improvements/${ref}`)).body;
    assert.deepEqual(m.links.map((l: any) => [l.kind, l.reference]).sort(), [['action', String(actionId)], ['change', chg], ['problem', prb]]);
    assert.equal(m.links.find((l: any) => l.kind === 'change').title, 'Add canary stage');
    assert.equal(m.links.find((l: any) => l.kind === 'action').action_problem_ref, prb);
    assert.equal((await analyst.post(`/api/improvements/${ref}/links`, { kind: 'change', reference: prb })).status, 400, 'the kind must match the ref');
    assert.equal((await analyst.post(`/api/improvements/${ref}/links`, { kind: 'action', reference: '999999' })).status, 404);
    assert.ok((await analyst.get(`/api/problems/${prb}`)).body.improvements.some((x: any) => x.ref === ref), 'the problem shows it');
    const link = m.links.find((l: any) => l.kind === 'change');
    ok(await analyst.del(`/api/improvements/${ref}/links/${link.id}`));
  });

  test('lessons learned from a resolved problem; a restricted source makes a restricted improvement', async () => {
    const prb = (await analyst.post('/api/problems', { title: 'Backups silently failing' })).body.ref;
    assert.equal((await analyst.post(`/api/problems/${prb}/improvement`, { title: 'Alert on missed backups' })).status, 409, 'once resolved or closed');
    ok(await analyst.post(`/api/problems/${prb}/transition`, { to: 'analysis' }));
    ok(await analyst.post(`/api/problems/${prb}/transition`, { to: 'resolved', resolution: 'Rotated the backup credentials' }));
    ok(await analyst.put(`/api/records/${prb}/visibility`, { restricted: true, teams: [], reason: 'Security finding' }));
    const r = await analyst.post(`/api/problems/${prb}/improvement`, { title: 'Alert on missed backups', description: 'From the backup credential incident.' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.source, 'problem');
    assert.equal(r.body.source_ref, prb);
    assert.equal(r.body.restricted, true, 'as narrow as its problem');
    assert.deepEqual(r.body.links, [], 'links are for the work that carries it out; the source is source_ref');
    assert.equal((await analyst2.get(`/api/improvements/${r.body.ref}`)).status, 404, 'others cannot see it');
    assert.equal((await analyst2.get(`/api/records/${r.body.ref}/history`)).status, 404);
    assert.ok(!(await analyst2.get('/api/improvements?status=all')).body.some((m: any) => m.ref === r.body.ref));
    assert.ok(!(await analyst2.get(`/api/search?q=${r.body.ref}`)).body.some((h: any) => h.ref === r.body.ref));
    assert.equal((await analyst.get(`/api/improvements/${r.body.ref}`)).status, 200, 'positive control: its creator sees it');
  });

  test('a review follow-up becomes an improvement, as narrow as the incident', async () => {
    const inc = (await analyst.post('/api/incidents', { title: 'VPN outage' })).body.ref;
    const review = (await analyst.post('/api/reviews', { incident: inc })).body.ref;
    let r = (await analyst.post(`/api/incidents/${inc}/review/items`, { kind: 'follow_up', body: 'Run a failover drill every quarter' })).body;
    const item = r.items.find((x: any) => x.kind === 'follow_up');
    ok(await pm.put(`/api/records/${inc}/classification`, { classification: 'confidential', reason: 'Names a supplier under NDA' }));
    r = (await analyst.post(`/api/incidents/${inc}/review/items/${item.id}/improvement`, {})).body;
    const imp = r.items.find((x: any) => x.id === item.id).improvement_ref;
    assert.match(imp, /^IMP\d{6}$/);
    assert.equal((await analyst.post(`/api/incidents/${inc}/review/items/${item.id}/action`, {})).status, 409, 'an action or an improvement, not both');
    assert.equal((await analyst.del(`/api/incidents/${inc}/review/items/${item.id}`)).status, 409, 'the item stays as the trace');
    assert.ok(r.next_steps.steps.find((s: any) => s.id === 'actions').done);
    const m = (await analyst.get(`/api/improvements/${imp}`)).body;
    assert.equal(m.source, 'review');
    assert.equal(m.source_ref, review);
    assert.equal(m.classification, 'confidential', 'as confidential as the incident');
    assert.equal(m.title, 'Run a failover drill every quarter');
    assert.match(m.description, /failover drill/, 'its creator reads the text');
    const masked = (await analyst2.get(`/api/improvements/${imp}`)).body;
    assert.equal(masked.description, null, 'others see the title, not the text');
    assert.equal(masked.confidential_masked, true);
  });

  test('a service review suggests one with the service prefilled; bulk and MCP work as for other records', async () => {
    const a = (await pm.post('/api/improvements', { title: 'Shorter payroll batch', source: 'service_review', source_ref: service, service, kpi: 'sla' })).body;
    assert.equal(a.source, 'service_review');
    assert.equal(a.restricted, false);
    const b = (await pm.post('/api/improvements', { title: 'Payroll status page' })).body;
    const bulk = (await pm.post('/api/improvements/bulk', { ids: [a.ref, b.ref], operation: { op: 'status', to: 'approved' } })).body;
    assert.equal(bulk.summary.changed, 2, JSON.stringify(bulk));
    const denied = (await analyst.post('/api/improvements/bulk', { ids: [a.ref], operation: { op: 'status', to: 'rejected', details: { reason: 'No' } } })).body;
    assert.equal(denied.summary.changed, 0, 'rejecting in bulk still takes a manager');
    const assigned = (await pm.post('/api/improvements/bulk', { ids: [a.ref, b.ref], operation: { op: 'assign', assignee_id: await userId('analyst') } })).body;
    assert.equal(assigned.summary.changed, 2);
    assert.ok((await analyst.get('/api/my-work')).body.improvements.some((m: any) => m.ref === a.ref), 'My work lists approved ones I own');

    const mcp = new McpClient({ name: 'improvements', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    try {
      const created: any = JSON.parse(((await mcp.callTool({ name: 'create_improvement', arguments: { title: 'Document the payroll runbook', value: 3, effort: 2, owner: 'analyst' } })) as any).content[0].text);
      assert.match(created.ref, /^IMP/);
      assert.equal(created.owner, 'Analyst');
      assert.equal(created.untrusted_content.title, 'Document the payroll runbook', 'free text goes out as untrusted_content');
      assert.equal(created.title, undefined);
      const listed: any = JSON.parse(((await mcp.callTool({ name: 'list_improvements', arguments: { owner: 'me' } })) as any).content[0].text);
      assert.ok(listed.some((m: any) => m.ref === created.ref));
      const refused: any = await mcp.callTool({ name: 'transition_improvement', arguments: { ref: created.ref, to: 'approved' } });
      assert.ok(refused.isError, 'an analyst cannot approve, over MCP either');
    } finally {
      await mcp.close();
    }
  });
});
