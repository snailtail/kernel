import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('problems and known errors on CIs (#26)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, viewer: Client;
  let svc: string, app: string, vm: string, prb: string;
  const ci = async (name: string, ci_type: string, extra: object = {}) => (await pm.post('/api/cis', { name, ci_type, ...extra })).body.ref as string;

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('viewer')]);
    svc = await ci('Payroll', 'business_service', { criticality: 1 });
    app = await ci('payroll-app', 'application');
    vm = await ci('payroll-vm01', 'virtual_machine');
    await pm.post(`/api/cis/${app}/relationships`, { type: 'member_of', target: svc });
    await pm.post(`/api/cis/${app}/relationships`, { type: 'runs_on', target: vm });
    prb = (await analyst.post('/api/problems', { title: 'Payslips fail to render', impact: 3, urgency: 2 })).body.ref;
  });
  after(() => k?.close());

  test('linking a CI derives affected services and an impact hint', async () => {
    assert.equal((await viewer.post(`/api/problems/${prb}/cis`, { ci: vm })).status, 403);
    const p = (await analyst.post(`/api/problems/${prb}/cis`, { ci: vm })).body;
    assert.deepEqual(p.affected_cis.map((c: any) => c.ref), [vm]);
    assert.deepEqual(p.affected_services.map((s: any) => [s.ref, s.via]), [[svc, [vm]]]);
    assert.equal(p.impact_hint.suggested_impact, 1);
    assert.match(p.impact_hint.reason, /Payroll \(business critical\)/);
    assert.equal(p.next_steps.steps.find((s: any) => s.id === 'categorise').done, false, 'category still missing');
    assert.equal((await analyst.post(`/api/problems/${prb}/cis`, { ci: vm })).status, 409);
    assert.equal((await analyst.patch(`/api/problems/${prb}`, { impact: 1 })).body.impact_hint, null, 'no hint once impact matches');
    const hist = (await admin.get(`/api/audit?entity_type=problem&entity_ref=${prb}`)).body;
    assert.ok(hist.some((e: any) => e.action === 'link' && e.changes.reference === vm));
  });

  test('the CI page shows known errors with their workaround', async () => {
    await analyst.post(`/api/problems/${prb}/transition`, { to: 'analysis' });
    await analyst.post(`/api/problems/${prb}/transition`, { to: 'known_error', root_cause: 'Font cache corrupt', workaround: 'Clear the font cache and retry' });
    const page = (await viewer.get(`/api/cis/${vm}`)).body;
    assert.equal(page.known_errors[0].ref, prb);
    assert.equal(page.known_errors[0].workaround, 'Clear the font cache and retry');
    assert.equal((await pm.post(`/api/cis/${vm}/links`, { kind: 'problem', reference: prb })).status, 400, 'problems are linked as affected CIs');
  });

  test('records carry their CI; candidates group by CI and link it when a problem is created', async () => {
    await admin.post('/api/users', { username: 'mon', display_name: 'Monitoring', role: 'integration', password: 'four quiet harbour lamps' });
    const bot = new Client(k.base);
    await bot.post('/api/auth/login', { username: 'mon', password: 'four quiet harbour lamps' });
    const mon = new Client(k.base, (await bot.post('/api/tokens', { name: 'mon' })).body.token);
    await pm.put('/api/candidates/rule', { min_records: 3, window_days: 7 });
    const sent = await mon.post('/api/integrations/records', {
      records: [
        { system: 'OP5', kind: 'event', reference: 'E1', ci: app, summary: 'HTTP 500' },
        { system: 'OP5', kind: 'event', reference: 'E2', service: 'PAYROLL-APP', summary: 'HTTP 500' },
        { system: 'OP5', kind: 'event', reference: 'E3', ci: app },
        { system: 'OP5', kind: 'event', reference: 'E4', ci: 'CI999999' },
      ],
    });
    assert.equal(sent.body.stored, 4);
    assert.deepEqual(sent.body.errors, [], 'an ingest token cannot probe which CI refs exist');
    const byPerson = await pm.post('/api/integrations/records', { records: [{ system: 'OP5', kind: 'event', reference: 'E5', ci: 'CI999999' }] });
    assert.match(byPerson.body.errors[0].error, /Unknown CI CI999999/);
    const cand = (await analyst.get('/api/candidates')).body.candidates.find((c: any) => c.ci_ref === app);
    assert.equal(cand.count, 3, 'by ref and by unique name');
    const created = await analyst.post('/api/candidates/create', { record_ids: cand.records.map((r: any) => r.id), problem: { title: 'Payroll app errors', detection: 'proactive' } });
    assert.deepEqual(created.body.affected_cis.map((c: any) => c.ref), [app]);
    const report = (await viewer.get(`/api/reports?from=2000-01-01&to=2100-01-01`)).body;
    const row = report.hotspots.cis.find((c: any) => c.ref === app);
    assert.deepEqual([row.records, row.unlinked, row.open_problems], [3, 0, 1]);
  });

  test('MCP: link from either side, and the problem context names affected CIs as data', async () => {
    const mcp = new McpClient({ name: 'p-ci', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const call = async (name: string, args: object) => JSON.parse(((await mcp.callTool({ name, arguments: args })) as any).content[0].text);
    const other = (await analyst.post('/api/problems', { title: 'Slow logins' })).body.ref;
    await call('link_records', { from: svc, to: other });
    const linked = await call('link_ci_to_problem', { problem: other, ci: vm });
    assert.deepEqual(linked.affected_cis.sort(), [svc, vm].sort());
    const ctx = await call('get_problem_context', { ref: other });
    assert.deepEqual(ctx.affected_cis.map((c: any) => c.ref).sort(), [svc, vm].sort());
    assert.equal(ctx.untrusted_content.ci_names[vm], 'payroll-vm01');
    assert.equal(ctx.known_errors_on_same_cis[0].ref, prb);
    assert.match(ctx.untrusted_content.known_error_workarounds[0].workaround, /font cache/);
    assert.equal(ctx.affected_cis[0].name, undefined, 'names only under untrusted_content');
    await call('unlink_ci_from_problem', { problem: other, ci: svc });
    assert.deepEqual((await analyst.get(`/api/problems/${other}`)).body.affected_cis.map((c: any) => c.ref), [vm]);
    await mcp.close();
  });
});
