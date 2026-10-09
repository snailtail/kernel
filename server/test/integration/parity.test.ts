// API/MCP parity: every registered record type must offer the same REST routes, MCP tools and OpenAPI entries,
// and the generic cross-practice operations must work for it (docs/api-conventions.md).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('API and MCP parity', { skip }, () => {
  let k: Harness;
  let analyst: Client;
  let mcp: McpClient;
  let doc: any;

  before(async () => {
    k = await startKernel();
    analyst = await k.login('analyst');
    doc = (await analyst.get('/api/openapi.json')).body;
    mcp = new McpClient({ name: 'parity', version: '1' });
    // An administrator sees every tool, so the parity check covers all of them.
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('admin')}` } } }));
  });
  after(async () => {
    await mcp?.close();
    await k?.close();
  });

  test('every record type has REST routes, MCP tools and OpenAPI entries', async () => {
    const { recordTypes } = await import('../../src/records.js');
    const types = recordTypes();
    assert.ok(types.length >= 1);
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    const routes = new Set(k.routes.map((r) => `${r.method} ${r.url}`));
    for (const t of types) {
      const expectRoute = (method: string, path: string) => {
        assert.ok(routes.has(`${method} ${path}`), `${t.type}: missing ${method.toUpperCase()} ${path}`);
        assert.ok(doc.paths[path.replace(/:(\w+)/g, '{$1}')]?.[method], `${t.type}: ${method.toUpperCase()} ${path} not in OpenAPI`);
      };
      expectRoute('get', t.rest.list);
      expectRoute('post', t.rest.create);
      expectRoute('get', t.rest.get);
      expectRoute('patch', t.rest.update);
      expectRoute('post', t.rest.transition);
      expectRoute('post', t.rest.links);
      expectRoute('post', t.rest.comments);
      for (const tool of Object.values(t.mcp)) assert.ok(tools.includes(tool), `${t.type}: missing MCP tool ${tool}`);
    }
    for (const generic of ['search', 'get_record', 'next_steps', 'my_work', 'link_records', 'add_comment']) assert.ok(tools.includes(generic), `missing ${generic}`);
  });

  test('generic operations work across types', async () => {
    const a = (await analyst.post('/api/problems', { title: 'Parity printer jam' })).body;
    const b = (await analyst.post('/api/problems', { title: 'Parity paper tray' })).body;
    assert.equal(a.type, 'problem');
    assert.match(a.url, new RegExp(`/problems/${a.ref}$`));

    const hits = (await analyst.get('/api/search?q=parity')).body;
    assert.ok(hits.some((h: any) => h.ref === a.ref && h.type === 'problem' && h.url));
    assert.equal((await analyst.get(`/api/records/${a.ref.toLowerCase()}`)).body.ref, a.ref);
    assert.equal((await analyst.get('/api/records/XYZ000001')).status, 404);
    assert.equal((await analyst.get(`/api/records/${a.ref}/next-steps`)).body.next_steps.phase, 'Problem identification');
    const links = (await analyst.post(`/api/records/${a.ref}/links`, { to: b.ref })).body;
    assert.ok(links.some((l: any) => l.kind === 'problem' && l.reference === b.ref));
    assert.equal((await analyst.post(`/api/records/${a.ref}/links`, { to: 'INC-1' })).status, 400, 'external refs need a kind');

    const work = (await analyst.get('/api/my-work')).body;
    assert.ok(Array.isArray(work.problems) && Array.isArray(work.actions));

    const res: any = await mcp.callTool({ name: 'get_record', arguments: { ref: a.ref } });
    assert.equal(JSON.parse(res.content[0].text).ref, a.ref);
  });

  test('Idempotency-Key makes retries safe', async () => {
    const key = `retry-${Date.now()}`;
    const first = await analyst.request('POST', '/api/problems', { title: 'Once only' }, { 'Idempotency-Key': key });
    const second = await analyst.request('POST', '/api/problems', { title: 'Once only' }, { 'Idempotency-Key': key });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.body.ref, first.body.ref, 'the same problem, not a duplicate');
    const other = await analyst.request('POST', '/api/problems/PRB000001/comments', { body: 'x' }, { 'Idempotency-Key': key });
    assert.equal(other.status, 422, 'a key cannot be reused for another request');
    const failed = await analyst.request('POST', '/api/problems', { title: '' }, { 'Idempotency-Key': `${key}-bad` });
    assert.equal(failed.status, 400);
    const retry = await analyst.request('POST', '/api/problems', { title: 'Fixed' }, { 'Idempotency-Key': `${key}-bad` });
    assert.equal(retry.status, 201, 'a failed request can be retried with its key');
  });
});
