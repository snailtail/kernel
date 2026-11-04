// Refs grow to seven digits once a sequence passes 999 999 (#229): INC1000000 is opened, linked, searched, traced and
// hidden like any other record, over REST and MCP.
import assert from 'node:assert/strict';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: any }, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};

describe('refs with seven digits (#229)', { skip }, () => {
  let k: Harness;
  let analyst: Client, analyst2: Client;
  let p: string, inc: string, imp: string;

  before(async () => {
    k = await startKernel();
    [analyst, analyst2] = await Promise.all([k.login('analyst'), k.login('analyst2')]);
    await ownerQuery("SELECT setval('incident_ref_seq', 999999)");
    inc = ok(await analyst2.post('/api/incidents', { title: 'Badge readers offline in building C' }), 201).ref;
    p = ok(await analyst2.post('/api/problems', { title: 'Badge controller firmware hangs' }), 201).ref;
    imp = ok(await analyst2.post('/api/improvements', { title: 'Watchdog on the badge controllers', source: 'idea', source_ref: inc }), 201).ref;
  });
  after(async () => k?.close());

  test('the sequence gives a seven-digit ref, and it opens over REST', async () => {
    assert.equal(inc, 'INC1000000', 'written in full, not cut to six digits by lpad');
    const [next] = (await ownerQuery("SELECT kernel_ref('CI', 1000001) AS a, kernel_ref('CI', 42) AS b")).rows;
    assert.deepEqual(next, { a: 'CI1000001', b: 'CI000042' });
    assert.equal(ok(await analyst.get(`/api/incidents/${inc}`)).ref, inc);
    assert.equal(ok(await analyst.get(`/api/records/${inc}`)).ref, inc);
  });

  test('it can be linked, and the trace follows the link and the improvement source', async () => {
    ok(await analyst2.post(`/api/records/${inc}/links`, { to: p, kind: 'problem' }));
    const trace = ok(await analyst.get(`/api/records/${p}/trace`));
    const refs = trace.nodes.map((n: any) => n.ref);
    assert.ok(refs.includes(inc), JSON.stringify(trace));
    assert.ok(ok(await analyst.get(`/api/records/${inc}/trace`)).nodes.some((n: any) => n.ref === imp), 'the improvement it is the source of');
  });

  test('search finds it by its ref', async () => {
    const hits = ok(await analyst.get(`/api/search?q=${inc}`));
    assert.ok(hits.some((h: any) => h.ref === inc), JSON.stringify(hits));
  });

  test('MCP opens it like REST', async () => {
    const mcp = new McpClient({ name: 'refs', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    try {
      const res: any = await mcp.callTool({ name: 'get_record', arguments: { ref: inc } });
      assert.ok(!res.isError, res.content[0].text);
      assert.equal(JSON.parse(res.content[0].text).ref, inc);
    } finally {
      await mcp.close();
    }
  });

  test('restricted, it is hidden from a reader without access', async () => {
    ok(await analyst2.put(`/api/records/${inc}/visibility`, { restricted: true, reason: 'Security investigation' }));
    assert.equal((await analyst.get(`/api/incidents/${inc}`)).status, 404);
    assert.equal((await analyst.get(`/api/records/${inc}`)).status, 404);
    assert.ok(!ok(await analyst.get(`/api/search?q=${inc}`)).some((h: any) => h.ref === inc));
    assert.ok(!JSON.stringify(ok(await analyst.get(`/api/records/${p}/trace`))).includes(inc));
    assert.equal(ok(await analyst.get(`/api/improvements/${imp}`)).source_ref, null);
    assert.equal(ok(await analyst2.get(`/api/incidents/${inc}`)).ref, inc, 'the one who restricted it still sees it');
  });
});
