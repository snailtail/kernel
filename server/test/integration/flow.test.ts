import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { skip, startKernel, type Harness, type Client } from './harness.js';

describe('process guidance across practices (#37)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, viewer: Client;

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('viewer')]);
  });
  after(() => k?.close());

  test('a known error decided "fix" hands over to a change; the change hands back to resolve the problem', async () => {
    const p = (await analyst.post('/api/problems', { title: 'Reports time out', assignee_id: undefined })).body;
    await analyst.post(`/api/problems/${p.ref}/transition`, { to: 'analysis' });
    await analyst.post(`/api/problems/${p.ref}/transition`, { to: 'known_error', root_cause: 'Missing index', workaround: 'Run reports at night' });
    const decided = (await pm.put(`/api/problems/${p.ref}/assessment`, { ec_decision: 'fix', ec_risk_level: 2 })).body;
    assert.deepEqual([decided.next_steps.handover.action, decided.next_steps.handover.label], ['raise_change', 'Ready to fix? Raise a change']);
    const change = (await analyst.post(`/api/problems/${p.ref}/change`, { implementation_plan: 'Add the index', backout_plan: 'Drop it' })).body;
    assert.equal((await analyst.get(`/api/problems/${p.ref}`)).body.next_steps.handover, null, 'the hand-over is done');
    await db(`UPDATE changes SET status = 'closed', outcome = 'successful' WHERE ref = '${change.ref}'`);
    const closed = (await analyst.get(`/api/changes/${change.ref}`)).body;
    assert.deepEqual([closed.next_steps.handover.action, closed.next_steps.handover.target], ['resolve_problem', p.ref]);
  });

  test('incidents hand over to a matching known error, or to a new problem when they recur', async () => {
    const ci = (await pm.post('/api/cis', { name: 'report-db', ci_type: 'database' })).body.ref;
    const ke = (await analyst.post('/api/problems', { title: 'Report DB locks' })).body.ref;
    await analyst.post(`/api/problems/${ke}/cis`, { ci });
    await analyst.post(`/api/problems/${ke}/transition`, { to: 'analysis' });
    await analyst.post(`/api/problems/${ke}/transition`, { to: 'known_error', root_cause: 'Long transactions', workaround: 'Kill the blocking session' });
    const i = (await analyst.post('/api/incidents', { title: 'Reports hang', cis: [ci] })).body;
    assert.deepEqual([i.next_steps.handover.action, i.next_steps.handover.target], ['link_problem', ke]);
    const plain = (await analyst.post('/api/incidents', { title: 'VPN flaky' })).body;
    assert.equal(plain.next_steps.handover, null);
    await analyst.post(`/api/incidents/${plain.ref}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Restarted' });
    const again = (await analyst.post(`/api/incidents/${plain.ref}/transition`, { to: 'in_progress' })).body;
    assert.equal(again.next_steps.handover.action, 'create_problem');
  });

  test('the process map counts live data, follows the modules, and is there for agents', async () => {
    const map = (await viewer.get('/api/flow')).body;
    assert.deepEqual(map.nodes.map((n: any) => n.id), ['event', 'incident', 'review', 'problem', 'known_error', 'change', 'resolution']);
    const ke = map.nodes.find((n: any) => n.id === 'known_error');
    assert.ok(ke.counts.find((c: any) => c.label === 'known errors').value >= 2);
    assert.ok(map.supporting.some((s: any) => s.id === 'cmdb'));
    await admin.put('/api/admin/modules', { change: false, reason: 'test' });
    const without = (await viewer.get('/api/flow')).body;
    assert.ok(!without.nodes.some((n: any) => n.id === 'change'));
    assert.ok(!without.nodes.find((n: any) => n.id === 'known_error').counts.some((c: any) => /without a change/.test(c.label)));
    assert.equal((await analyst.get(`/api/problems?status=known_error`)).body.length >= 1, true);
    await admin.put('/api/admin/modules', { change: true, reason: 'test' });
    await analyst.post('/api/problems', { title: 'Nobody owns me' });
    const tips = (await viewer.get('/api/health-tips')).body;
    assert.ok(tips.some((t: any) => t.id === 'no_owner'));
    const mcp = new McpClient({ name: 'flow', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const res = JSON.parse(((await mcp.callTool({ name: 'get_process_map', arguments: {} })) as any).content[0].text);
    assert.equal(res.nodes[0].id, 'event');
    assert.ok((await mcp.listResources()).resources.some((r) => r.uri === 'kernel://guides/change_assessment'));
    await mcp.close();
  });

  async function db(sql: string) {
    const { query } = await import('../../src/db.js');
    await query(sql);
  }
});
