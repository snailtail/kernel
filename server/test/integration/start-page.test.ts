import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { skip, startKernel, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: unknown }) => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);
const start = async (c: Client) => {
  const me = (await c.get('/api/auth/me')).body;
  return { home: me.home, default_new: me.default_new };
};

describe('a personal start page and default process (#171)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, viewer: Client;
  before(async () => {
    k = await startKernel();
    [admin, pm, analyst, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('viewer')]);
  });
  after(async () => k?.close());

  test('no practice is favoured: everyone starts on My work and creates incidents', async () => {
    for (const c of [admin, pm, analyst, viewer]) assert.deepEqual(await start(c), { home: 'my_work', default_new: 'incident' });
  });

  test('a person chooses their own; unknown values are refused, null follows the default again', async () => {
    ok(await analyst.put('/api/auth/preferences', { home: 'changes', default_new: 'change' }));
    assert.deepEqual(await start(analyst), { home: 'changes', default_new: 'change' });
    assert.equal((await analyst.put('/api/auth/preferences', { home: 'board' })).status, 400);
    assert.equal((await analyst.put('/api/auth/preferences', { default_new: 'event' })).status, 400);
    ok(await analyst.put('/api/auth/preferences', { home: null, default_new: null }));
    assert.deepEqual(await start(analyst), { home: 'my_work', default_new: 'incident' });
  });

  test('an administrator sets defaults per role; a person\'s own choice wins', async () => {
    assert.equal((await pm.put('/api/admin/start-pages', { problem_manager: { home: 'problems' } })).status, 403, 'administrators only');
    assert.equal((await admin.put('/api/admin/start-pages', { integration: { home: 'problems' } })).status, 400, 'integration accounts have no start page');
    ok(await admin.put('/api/admin/start-pages', { problem_manager: { home: 'problems', default_new: 'problem' }, analyst: { home: 'incidents' }, reason: 'Start pages' }));
    assert.deepEqual(await start(pm), { home: 'problems', default_new: 'problem' });
    assert.deepEqual(await start(analyst), { home: 'incidents', default_new: 'incident' });
    assert.deepEqual(await start(viewer), { home: 'my_work', default_new: 'incident' });
    ok(await pm.put('/api/auth/preferences', { home: 'dashboard' }));
    assert.deepEqual(await start(pm), { home: 'dashboard', default_new: 'problem' });
    // Fields merge; null clears one.
    ok(await admin.put('/api/admin/start-pages', { problem_manager: { default_new: null } }));
    assert.deepEqual((await admin.get('/api/admin/start-pages')).body.problem_manager, { home: 'problems' });
    const entry = (await admin.get('/api/audit?entity_type=setting')).body.find((e: any) => e.entity_ref === 'start_pages');
    assert.ok(entry, 'the change is in the audit trail');
  });

  test('a choice whose module is off falls back, and comes back with the module', async () => {
    ok(await viewer.put('/api/auth/preferences', { home: 'requests', default_new: 'request' }));
    assert.deepEqual(await start(viewer), { home: 'my_work', default_new: 'incident' }, 'service requests are off by default');
    ok(await admin.put('/api/admin/modules', { request: true, incident: false, reason: 'Start page fallback' }));
    assert.deepEqual(await start(viewer), { home: 'requests', default_new: 'request' });
    // With incidents off, the analyst's role default (incidents) and the built-in default both fall back.
    assert.deepEqual(await start(analyst), { home: 'my_work', default_new: 'problem' });
    ok(await admin.put('/api/admin/modules', { request: false, incident: true, reason: 'Back' }));
  });

  test('the dashboard and its KPIs need the general read permission; MCP whoami returns the focus', async () => {
    ok(await viewer.get('/api/dashboard'));
    const mcp = new McpClient({ name: 'start', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const me = JSON.parse(((await mcp.callTool({ name: 'whoami', arguments: {} })).content as { text: string }[])[0].text);
    assert.deepEqual([me.home, me.default_new], ['incidents', 'incident']);
    const dash = JSON.parse(((await mcp.callTool({ name: 'get_dashboard', arguments: {} })).content as { text: string }[])[0].text);
    assert.ok(dash.kpis && dash.by_status, 'backlog and KPIs');
    await mcp.close();
  });
});
