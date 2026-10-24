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
  let pm: Client;
  let mcp: McpClient;
  let doc: any;

  before(async () => {
    k = await startKernel();
    analyst = await k.login('analyst');
    pm = await k.login('pm');
    // Service requests (#44) are an optional module, off by default: on here so the check covers them.
    await (await k.login('admin')).put('/api/admin/modules', { request: true, reason: 'Parity' });
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
    const { recordTypes } = await import('../../src/records/records.js');
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
    for (const generic of ['search', 'get_record', 'next_steps', 'my_work', 'link_records', 'add_comment', 'get_history', 'get_impact']) assert.ok(tools.includes(generic), `missing ${generic}`);
    for (const path of ['/api/records/:ref', '/api/records/:ref/next-steps', '/api/records/:ref/history', '/api/records/:ref/impact']) assert.ok(routes.has(`get ${path}`), `missing GET ${path}`);
    for (const path of ['/api/records/:ref/links', '/api/records/:ref/comments']) assert.ok(routes.has(`post ${path}`), `missing POST ${path}`);
  });

  // One way to make a record of each registered type. A new type fails here until it has one, so the checks below
  // cover it from the day it is registered.
  const MAKE: Record<string, () => Promise<string>> = {
    problem: async () => (await analyst.post('/api/problems', { title: 'Parity envelope' })).body.ref,
    incident: async () => (await analyst.post('/api/incidents', { title: 'Parity envelope' })).body.ref,
    change: async () => (await analyst.post('/api/changes', { title: 'Parity envelope' })).body.ref,
    ci: async () => (await pm.post('/api/cis', { name: `parity-vm-${Date.now()}`, ci_type: 'virtual_machine' })).body.ref,
    service: async () => (await pm.post('/api/cis', { name: `Parity service ${Date.now()}`, ci_type: 'business_service' })).body.ref,
    article: async () => (await analyst.post('/api/articles', { title: 'Parity envelope', body: 'Steps.' })).body.ref,
    improvement: async () => (await analyst.post('/api/improvements', { title: 'Parity envelope' })).body.ref,
    request: async () => {
      const service = (await pm.post('/api/cis', { name: `Parity requests ${Date.now()}`, ci_type: 'business_service' })).body.ref;
      const item = (await pm.post('/api/request-items', { service, name: 'Parity item', fulfilment_tasks: [{ title: 'Do it' }] })).body.id;
      const person = (await analyst.post('/api/people', { name: `Parity person ${Date.now()}` })).body.id;
      const r = await analyst.post('/api/requests', { item_id: item, requester: { id: person } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.ref;
    },
    review: async () => {
      const inc = (await analyst.post('/api/incidents', { title: 'Parity review' })).body.ref;
      const r = await analyst.post('/api/reviews', { incident: inc });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.ref;
    },
  };

  test('every type returns the same envelope, history and comments over REST and MCP', async () => {
    const { recordTypes } = await import('../../src/records/records.js');
    for (const t of recordTypes()) {
      assert.ok(MAKE[t.type], `${t.type}: add a way to make one to this test`);
      const ref = await MAKE[t.type]();
      assert.ok(t.pattern ? t.pattern.test(ref) : ref.startsWith(t.prefix), `${t.type}: ${ref} has the ${t.prefix} prefix`);
      const viaRest = (await analyst.get(t.rest.get.replace(':ref', ref))).body;
      const viaMcp: any = JSON.parse(((await mcp.callTool({ name: t.mcp.get, arguments: { ref } })) as any).content[0].text);
      for (const [surface, r] of [['REST', viaRest], ['MCP', viaMcp]] as const) {
        assert.equal(r.ref, ref, `${t.type} ${surface}: ref`);
        assert.equal(r.type, t.type, `${t.type} ${surface}: type`);
        assert.equal(typeof r.status, 'string', `${t.type} ${surface}: status`);
        assert.ok(String(r.url).endsWith(t.uiPath(ref)), `${t.type} ${surface}: url ${r.url}`);
        assert.ok(r.next_steps && typeof r.next_steps.phase === 'string' && Array.isArray(r.next_steps.steps), `${t.type} ${surface}: next_steps`);
      }
      assert.equal((await analyst.get(`/api/records/${ref}`)).body.ref, ref, `${t.type}: get_record`);
      assert.ok((await analyst.get(`/api/search?q=${ref}`)).body.some((h: any) => h.ref === ref && h.type === t.type), `${t.type}: search by ref`);

      const comment = await pm.post(`/api/records/${ref}/comments`, { body: `Parity note on ${ref}` });
      assert.equal(comment.status, 201, `${t.type}: comment ${JSON.stringify(comment.body)}`);
      const history = await analyst.get(`/api/records/${ref}/history`);
      assert.equal(history.status, 200, `${t.type}: history`);
      assert.ok(history.body.length >= 1 && history.body.every((e: any) => !('user_agent' in e)), `${t.type}: history has entries`);
      const viaTool: any = JSON.parse(((await mcp.callTool({ name: 'get_history', arguments: { ref } })) as any).content[0].text);
      assert.equal(viaTool.length, history.body.length, `${t.type}: get_history matches REST`);
    }
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

  test('get_impact is for CIs and services; history follows visibility', async () => {
    const svc = (await pm.post('/api/cis', { name: `Impact service ${Date.now()}`, ci_type: 'business_service' })).body.ref;
    const vm = (await pm.post('/api/cis', { name: `impact-vm-${Date.now()}`, ci_type: 'virtual_machine' })).body.ref;
    await pm.post(`/api/cis/${svc}/relationships`, { type: 'depends_on', target: vm });
    const viaRest = (await analyst.get(`/api/records/${vm}/impact`)).body;
    const viaMcp: any = JSON.parse(((await mcp.callTool({ name: 'get_impact', arguments: { ref: vm } })) as any).content[0].text);
    const old: any = JSON.parse(((await mcp.callTool({ name: 'get_ci_impact', arguments: { ref: vm } })) as any).content[0].text);
    assert.deepEqual(viaMcp.services, old.services, 'get_impact is get_ci_impact under the generic name');
    assert.deepEqual(viaRest.services, old.services);
    const p = (await analyst.post('/api/problems', { title: 'No impact graph' })).body.ref;
    const bad = await analyst.get(`/api/records/${p}/impact`);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /CIs and services/);
    const tool: any = await mcp.callTool({ name: 'get_impact', arguments: { ref: p } });
    assert.ok(tool.isError);

    // A restricted record's history answers like one that does not exist for someone who cannot see it.
    const hidden = (await pm.post('/api/incidents', { title: 'Parity restricted' })).body.ref;
    const r = await pm.post('/api/reviews', { incident: hidden });
    assert.equal((await pm.put(`/api/records/${hidden}/visibility`, { restricted: true, teams: [], reason: 'Parity check' })).status, 200);
    assert.equal((await analyst.get(`/api/records/${hidden}/history`)).status, 404);
    assert.equal((await analyst.get(`/api/records/${r.body.ref}/history`)).status, 404, 'and so does its review');
    assert.equal((await analyst.get(`/api/reviews/${r.body.ref}`)).status, 404);
    assert.equal((await pm.get(`/api/records/${r.body.ref}/history`)).status, 200, 'positive control: its creator sees it');
  });

  test('a review is reached by either ref and shares its incident\'s links', async () => {
    const inc = (await analyst.post('/api/incidents', { title: 'Parity links' })).body.ref;
    const review = (await analyst.post('/api/reviews', { incident: inc })).body;
    assert.equal(review.incident_ref, inc);
    assert.equal((await analyst.get(`/api/incidents/${inc}/review`)).body.ref, review.ref, 'the incident path still works');
    const p = (await analyst.post('/api/problems', { title: 'Parity review link' })).body.ref;
    assert.equal((await analyst.post(`/api/reviews/${review.ref}/links`, { to: p })).status, 200);
    assert.equal((await analyst.get(`/api/incidents/${inc}`)).body.problem_ref, p, 'linking the review linked its incident');
    const commented = (await analyst.post(`/api/reviews/${review.ref}/comments`, { body: 'Agreed on the timeline' })).body;
    assert.deepEqual(commented.comments.map((c: any) => c.body), ['Agreed on the timeline']);
    assert.equal((await analyst.post(`/api/reviews/${review.ref}/transition`, { to: 'waived', reason: 'Nothing to learn' })).status, 403, 'waiving takes a manager');
    const published = (await analyst.post(`/api/reviews/${review.ref}/transition`, { to: 'published' })).body;
    assert.equal(published.status, 'published');
    assert.equal(published.next_steps.phase, 'Published');
    const history = (await analyst.get(`/api/records/${review.ref}/history`)).body.map((e: any) => e.action);
    for (const a of ['create', 'comment', 'publish']) assert.ok(history.includes(a), `history has ${a}: ${history}`);
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
