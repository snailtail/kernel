import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { skip, startKernel, type Harness } from './harness.js';

describe('MCP server', { skip }, () => {
  let k: Harness;
  let mcp: McpClient;
  let viewerMcp: McpClient;

  const connect = async (token: string) => {
    const client = new McpClient({ name: 'kernel-tests', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    return client;
  };

  const call = async (client: McpClient, name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    return { isError: !!res.isError, text, data: res.isError ? null : JSON.parse(text) };
  };

  before(async () => {
    k = await startKernel();
    mcp = await connect(await k.tokenFor('pm'));
    viewerMcp = await connect(await k.tokenFor('viewer'));
  });
  after(async () => {
    await mcp?.close();
    await viewerMcp?.close();
    await k?.close();
  });

  test('advertises instructions and tools', async () => {
    assert.match(mcp.getInstructions() ?? '', /ITIL 4/);
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of ['search_problems', 'get_problem', 'create_problem', 'transition_problem', 'link_record', 'search_known_errors']) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
    assert.equal(tools.find((t) => t.name === 'get_problem')?.annotations?.readOnlyHint, true);
  });

  test('acts as the token owner', async () => {
    assert.equal((await call(mcp, 'whoami')).data.username, 'pm');
  });

  test('runs a problem from creation to known error', async () => {
    const created = await call(mcp, 'create_problem', {
      title: 'Disk filling on db cluster',
      detection: 'proactive',
      category: 'Database',
      assignee: 'analyst',
      impact: 2,
      urgency: 2,
    });
    assert.equal(created.isError, false, created.text);
    const ref = created.data.ref;
    assert.equal(created.data.category, 'Database');
    assert.equal(created.data.assignee, 'Analyst');

    const linked = await call(mcp, 'link_record', { ref, kind: 'event', reference: 'ZBX-1', system: 'Zabbix' });
    assert.equal(linked.data[0].reference, 'ZBX-1');

    await call(mcp, 'transition_problem', { ref, to: 'analysis' });
    const blocked = await call(mcp, 'transition_problem', { ref, to: 'known_error' });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /root cause/);

    const ke = await call(mcp, 'transition_problem', { ref, to: 'known_error', root_cause: 'WAL archiving stalled', workaround: 'Prune WAL' });
    assert.equal(ke.data.status, 'known_error');

    await call(mcp, 'add_comment', { ref, body: 'Archive target was full' });
    const problem = await call(mcp, 'get_problem', { ref });
    assert.equal(problem.data.activity[0].kind, 'comment');
    assert.equal(problem.data.links.length, 1);

    const kedb = await call(mcp, 'search_known_errors', { q: 'wal' });
    assert.deepEqual(kedb.data.map((p: any) => p.ref), [ref]);
    const search = await call(mcp, 'search_problems', { q: 'disk', status: 'all' });
    assert.ok(search.data.some((p: any) => p.ref === ref));
  });

  test('reports helpful errors', async () => {
    const unknown = await call(mcp, 'update_problem', { ref: 'PRB000001', category: 'Nope' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /list_reference_data/);
    const missing = await call(mcp, 'get_problem', { ref: 'PRB999999' });
    assert.equal(missing.isError, true);
  });

  test('enforces the token owner role', async () => {
    const res = await call(viewerMcp, 'create_problem', { title: 'Nope' });
    assert.equal(res.isError, true);
    assert.match(res.text, /role/);
  });
});
