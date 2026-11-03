// History never shows the ref of a record the reader may not see (#227): an entry written before the record was
// restricted is redacted at read time, the same in REST, MCP and the audit history, and stays whole for those who may.
import assert from 'node:assert/strict';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: any }, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};

describe('history and records restricted later (#227)', { skip }, () => {
  let k: Harness;
  let analyst: Client, analyst2: Client;
  let p: string, inc: string;

  before(async () => {
    k = await startKernel();
    [analyst, analyst2] = await Promise.all([k.login('analyst'), k.login('analyst2')]);
    p = ok(await analyst.post('/api/problems', { title: 'Payroll export drops rows' }), 201).ref;
    inc = ok(await analyst2.post('/api/incidents', { title: 'Payslips missing for one department' }), 201).ref;
    ok(await analyst2.post(`/api/records/${inc}/links`, { to: p, kind: 'problem' }));
    ok(await analyst2.put(`/api/records/${inc}/visibility`, { restricted: true, reason: 'Security investigation' }));
    assert.equal((await analyst.get(`/api/incidents/${inc}`)).status, 404, 'the analyst cannot see the incident');
  });
  after(async () => k?.close());

  const linkEntry = (activity: any[]) => activity.find((a) => a.kind === 'link' && a.data.kind === 'incident');

  test('a link entry made before the restriction shows no ref to a reader without access', async () => {
    const r = ok(await analyst.get(`/api/problems/${p}`));
    const entry = linkEntry(r.activity);
    assert.equal(entry.body, 'Linked a restricted incident');
    assert.deepEqual(entry.data, { kind: 'incident', reference: null, system: 'Kernel', action: 'add', restricted: true });
    assert.ok(!JSON.stringify(r.activity).includes(inc), 'not in any entry');

    const seen = linkEntry(ok(await analyst2.get(`/api/problems/${p}`)).activity);
    assert.equal(seen.body, `Linked incident ${inc}`, 'the stored entry is unchanged for a reader with access');
    assert.deepEqual(seen.data, { kind: 'incident', reference: inc, system: 'Kernel', action: 'add' });
  });

  test('the audit history redacts it too, and keeps it for a reader with access', async () => {
    const trail = ok(await analyst.get(`/api/records/${p}/history`));
    assert.ok(trail.some((e: any) => e.action === 'link' && e.changes.restricted === true && e.changes.reference === null));
    assert.ok(!JSON.stringify(trail).includes(inc));
    assert.ok(JSON.stringify(ok(await analyst2.get(`/api/records/${p}/history`))).includes(inc));
  });

  test('a seven-digit ref, once the sequence passes 999 999, is hidden too', async () => {
    // The rest of Kernel does not take seven-digit refs yet, so the incident and its link entry are made directly.
    const six = ok(await analyst2.post('/api/incidents', { title: 'Payslips sent twice' }), 201).ref;
    ok(await analyst2.put(`/api/records/${six}/visibility`, { restricted: true, reason: 'Security investigation' }));
    await ownerQuery("UPDATE incidents SET ref = 'INC1000000' WHERE ref = $1", [six]);
    await ownerQuery(
      `INSERT INTO problem_activity (problem_id, kind, body, data) SELECT id, 'link', 'Linked incident INC1000000', $2 FROM problems WHERE ref = $1`,
      [p, JSON.stringify({ kind: 'incident', reference: 'INC1000000', system: 'Kernel', action: 'add' })],
    );
    const r = ok(await analyst.get(`/api/problems/${p}`));
    assert.ok(!JSON.stringify(r.activity).includes('INC1000000'));
    assert.ok(JSON.stringify(ok(await analyst2.get(`/api/problems/${p}`)).activity).includes('Linked incident INC1000000'));
  });

  test('MCP gives the same as REST', async () => {
    const rest = ok(await analyst.get(`/api/problems/${p}`));
    const mcp = new McpClient({ name: 'history', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    try {
      const res: any = await mcp.callTool({ name: 'get_record', arguments: { ref: p } });
      const text = res.content[0].text as string;
      assert.ok(!text.includes(inc));
      assert.deepEqual(linkEntry(JSON.parse(text).activity).data, linkEntry(rest.activity).data);
      const history: any = await mcp.callTool({ name: 'get_history', arguments: { ref: p } });
      assert.ok(!history.content[0].text.includes(inc));
    } finally {
      await mcp.close();
    }
  });
});
