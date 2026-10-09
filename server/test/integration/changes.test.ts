import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('change enablement (#29)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, viewer: Client;
  let svc: string, db: string, app: string;
  const at = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
  const plans = { implementation_plan: 'Apply patch 1.2.3', test_plan: 'Smoke test', backout_plan: 'Restore snapshot' };

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('viewer')]);
    svc = (await pm.post('/api/cis', { name: 'Billing', ci_type: 'business_service', criticality: 1 })).body.ref;
    db = (await pm.post('/api/cis', { name: 'billing-db', ci_type: 'database' })).body.ref;
    app = (await pm.post('/api/cis', { name: 'billing-app', ci_type: 'application' })).body.ref;
    await pm.post(`/api/cis/${app}/relationships`, { type: 'member_of', target: svc });
    await pm.post(`/api/cis/${app}/relationships`, { type: 'uses_database', target: db });
  });
  after(() => k?.close());

  const create = async (body: object, as = analyst) => {
    const r = await as.post('/api/changes', { title: 'Patch billing database', ...body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };

  test('a normal change is assessed from the CMDB and authorised by others, never its requester', async () => {
    assert.equal((await viewer.post('/api/changes', { title: 'x' })).status, 403);
    const c = await create({ cis: [db] });
    assert.match(c.ref, /^CHG\d{6}$/);
    assert.deepEqual([c.risk, c.approvals.required], ['high', 2], 'the database sits behind a business critical service');
    assert.match(c.risk_reason, /Billing/);
    const go = (body: object, as = analyst) => as.post(`/api/changes/${c.ref}/transition`, body);
    assert.equal((await go({ to: 'authorize' })).status, 409, 'assess first');
    assert.equal((await go({ to: 'assess' })).body.status, 'assess');
    assert.match((await go({ to: 'authorize' })).body.error, /implementation and backout plans/);
    await analyst.patch(`/api/changes/${c.ref}`, { ...plans, planned_start: at(48), planned_end: at(50) });
    assert.equal((await go({ to: 'authorize' })).body.status, 'authorize');
    assert.equal((await analyst.patch(`/api/changes/${c.ref}`, { backout_plan: 'Hope' })).status, 409, 'plans are locked once submitted');
    assert.equal((await analyst.post(`/api/changes/${c.ref}/votes`, { decision: 'approve' })).status, 403, 'analysts are not the change authority');
    const token = new Client(k.base, await k.tokenFor('pm'));
    assert.equal((await token.post(`/api/changes/${c.ref}/votes`, { decision: 'approve' })).status, 403, 'never through a token');
    const one = await pm.post(`/api/changes/${c.ref}/votes`, { decision: 'approve', comment: 'Fine' });
    assert.deepEqual([one.body.status, one.body.approvals.approved], ['authorize', 1]);
    assert.equal((await pm.post(`/api/changes/${c.ref}/votes`, { decision: 'approve' })).status, 409, 'one vote each');
    const two = await admin.post(`/api/changes/${c.ref}/votes`, { decision: 'approve' });
    assert.equal(two.body.status, 'scheduled');
    const own = await create({ title: 'Mine', cis: [app], ...plans, planned_start: at(72), planned_end: at(73) }, pm);
    await pm.post(`/api/changes/${own.ref}/transition`, { to: 'assess' });
    await pm.post(`/api/changes/${own.ref}/transition`, { to: 'authorize' });
    assert.equal((await pm.post(`/api/changes/${own.ref}/votes`, { decision: 'approve' })).status, 403, 'segregation of duties');
    const rejected = await admin.post(`/api/changes/${own.ref}/votes`, { decision: 'reject', comment: 'Not this week' });
    assert.equal(rejected.body.status, 'rejected');
    const redo = await pm.post(`/api/changes/${own.ref}/transition`, { to: 'draft' });
    assert.deepEqual([redo.body.status, redo.body.votes.length], ['draft', 0]);
  });

  test('implementation records the outcome; failures need a review; the schedule shows collisions', async () => {
    const [scheduled] = (await viewer.get('/api/changes?status=scheduled')).body;
    const clash = await create({ title: 'Index rebuild', cis: [db], ...plans, planned_start: at(49), planned_end: at(51) });
    const detail = (await viewer.get(`/api/changes/${clash.ref}`)).body;
    assert.equal(detail.collisions[0].ref, scheduled.ref);
    await analyst.post(`/api/changes/${clash.ref}/transition`, { to: 'assess' }); // drafts are not on the schedule
    const sched = (await viewer.get(`/api/changes/schedule?from=${at(0).slice(0, 10)}&to=${at(96).slice(0, 10)}`)).body;
    assert.ok(sched.collisions.some((x: any) => x.ci === db));
    const go = (body: object) => analyst.post(`/api/changes/${scheduled.ref}/transition`, body);
    assert.ok((await go({ to: 'implementing' })).body.actual_start);
    assert.equal((await go({ to: 'review' })).status, 409, 'outcome required');
    await go({ to: 'review', outcome: 'rolled_back' });
    assert.match((await go({ to: 'closed' })).body.error, /post-implementation review/);
    assert.equal((await go({ to: 'closed', review: 'Backout worked; test data was missing.' })).body.status, 'closed');
  });

  test('freezes block normal scheduling unless the change authority overrides with a reason', async () => {
    assert.equal((await analyst.post('/api/change-freezes', { name: 'x', starts_at: at(100), ends_at: at(110) })).status, 403);
    await pm.post('/api/change-freezes', { name: 'Year-end freeze', starts_at: at(100), ends_at: at(200), reason: 'Closing the books' });
    const c = await create({ title: 'Upgrade during freeze', cis: [app], ...plans, planned_start: at(120), planned_end: at(121) });
    await analyst.post(`/api/changes/${c.ref}/transition`, { to: 'assess' });
    assert.match((await analyst.post(`/api/changes/${c.ref}/transition`, { to: 'authorize' })).body.error, /Year-end freeze/);
    assert.equal((await analyst.post(`/api/changes/${c.ref}/transition`, { to: 'authorize', override_freeze_reason: 'Legal requirement' })).status, 403);
    assert.equal((await pm.post(`/api/changes/${c.ref}/transition`, { to: 'authorize', override_freeze_reason: 'Legal requirement' })).body.status, 'authorize');
  });

  test('standard changes come from templates; pipelines register them as done', async () => {
    assert.equal((await analyst.post('/api/changes', { title: 'x', change_type: 'standard' })).status, 400);
    const t = (await pm.post('/api/change-templates', { name: 'Deploy billing-app', implementation_plan: 'Run the pipeline', backout_plan: 'Redeploy previous version' })).body;
    const c = await create({ title: 'Deploy 4.2', template_id: t.id, cis: [app], planned_start: at(5), planned_end: at(6) });
    assert.deepEqual([c.change_type, c.approvals.required, c.backout_plan], ['standard', 0, 'Redeploy previous version']);
    assert.equal((await analyst.post(`/api/changes/${c.ref}/transition`, { to: 'scheduled' })).body.status, 'scheduled', 'pre-approved');
    await admin.post('/api/users', { username: 'ci-pipeline', display_name: 'Pipeline', role: 'integration', password: 'four quiet harbour lamps' });
    const bot = new Client(k.base);
    await bot.post('/api/auth/login', { username: 'ci-pipeline', password: 'four quiet harbour lamps' });
    const pipeline = new Client(k.base, (await bot.post('/api/tokens', { name: 'deploy' })).body.token);
    const reg = await pipeline.post('/api/changes/register', {
      template_id: t.id, title: 'Deploy 4.3', cis: [app], actual_start: at(-1), outcome: 'successful',
      links: [{ kind: 'pull_request', reference: 'billing#123', url: 'https://git.example/billing/pull/123' }],
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const done = (await viewer.get(`/api/changes/${reg.body.ref}`)).body;
    assert.deepEqual([done.status, done.source, done.outcome, done.links[0].kind], ['closed', 'pipeline', 'successful', 'pull_request']);
    assert.equal((await pipeline.post('/api/changes', { title: 'x' })).status, 403, 'pipelines only register standard changes');
  });

  test('emergency changes skip the window but still need approval before implementation', async () => {
    const c = await create({ title: 'Hotfix billing', change_type: 'emergency', cis: [app], ...plans });
    await analyst.post(`/api/changes/${c.ref}/transition`, { to: 'assess' });
    assert.equal((await analyst.post(`/api/changes/${c.ref}/transition`, { to: 'authorize' })).body.status, 'authorize');
    assert.match((await analyst.post(`/api/changes/${c.ref}/transition`, { to: 'implementing' })).body.error, /not approved/);
    const voted = await pm.post(`/api/changes/${c.ref}/votes`, { decision: 'approve' });
    assert.equal(voted.body.approvals.required, 2, 'emergency raises the risk');
    await admin.post(`/api/changes/${c.ref}/votes`, { decision: 'approve' });
    assert.equal((await analyst.post(`/api/changes/${c.ref}/transition`, { to: 'implementing' })).body.status, 'implementing');
  });

  test('problems raise changes for their fix; incidents after a change on what they depend on are flagged', async () => {
    const prb = (await analyst.post('/api/problems', { title: 'Billing slow at month end' })).body.ref;
    await analyst.post(`/api/problems/${prb}/cis`, { ci: db });
    const raised = await analyst.post(`/api/problems/${prb}/change`, {});
    assert.equal(raised.status, 201, JSON.stringify(raised.body));
    assert.deepEqual([raised.body.problem_ref, raised.body.affected_cis.map((c: any) => c.ref)], [prb, [db]]);
    const p = (await viewer.get(`/api/problems/${prb}`)).body;
    assert.ok(p.links.some((l: any) => l.kind === 'change' && l.reference === raised.body.ref));
    assert.equal(p.changes[0].ref, raised.body.ref);
    // A change on the database starts now; an incident on the app (which uses the database) follows.
    const hot = await create({ title: 'Emergency DB parameter', change_type: 'emergency', cis: [db], ...plans });
    await analyst.post(`/api/changes/${hot.ref}/transition`, { to: 'assess' });
    await analyst.post(`/api/changes/${hot.ref}/transition`, { to: 'authorize' });
    await pm.post(`/api/changes/${hot.ref}/votes`, { decision: 'approve' });
    await admin.post(`/api/changes/${hot.ref}/votes`, { decision: 'approve' });
    await analyst.post(`/api/changes/${hot.ref}/transition`, { to: 'implementing' });
    const inc = (await analyst.post('/api/incidents', { title: 'Invoices fail', cis: [app] })).body;
    assert.ok(inc.possible_change_causes.some((c: any) => c.ref === hot.ref && c.ci === db));
    assert.ok((await viewer.get(`/api/changes/${hot.ref}`)).body.related_incidents.some((i: any) => i.ref === inc.ref));
    const report = (await viewer.get('/api/reports?from=2000-01-01&to=2100-01-01')).body.changes;
    assert.ok(report.followed_by_incidents >= 1);
    assert.ok(report.emergency >= 2);
  });

  test('MCP: change tools keep text untrusted and never vote', async () => {
    const mcp = new McpClient({ name: 'chg', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('pm')}` } } }));
    const call = async (name: string, args: object) => JSON.parse(((await mcp.callTool({ name, arguments: args })) as any).content[0].text);
    const c = await call('create_change', { title: 'Rotate certificates', cis: [app], idempotency_key: 'chg-1', ...plans });
    assert.equal(c.untrusted_content.title, 'Rotate certificates');
    assert.equal((await call('create_change', { title: 'Rotate certificates', cis: [app], idempotency_key: 'chg-1', ...plans })).ref, c.ref);
    const vote = await call('approve_change', { ref: c.ref });
    assert.equal(vote.voted, false);
    const sched = await call('get_change_schedule', {});
    assert.ok(Array.isArray(sched.changes));
    await mcp.close();
  });
});
