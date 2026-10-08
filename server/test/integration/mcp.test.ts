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

  test('manages follow-up actions', async () => {
    const { data: p } = await call(mcp, 'create_problem', { title: 'Backup job fails weekly' });
    const added = await call(mcp, 'add_action', { ref: p.ref, title: 'Ask vendor for fix', owner: 'analyst', due_date: '2099-01-31' });
    assert.equal(added.isError, false, added.text);
    const id = added.data[0].id;
    const listed = await call(mcp, 'list_actions', { owner: 'analyst' });
    assert.ok(listed.data.some((a: any) => a.id === id));
    const done = await call(mcp, 'update_action', { ref: p.ref, action_id: id, status: 'done' });
    assert.equal(done.data[0].status, 'done');
  });

  test('assesses a known error', async () => {
    const { data: p } = await call(mcp, 'create_problem', { title: 'Printer queue stalls' });
    await call(mcp, 'transition_problem', { ref: p.ref, to: 'analysis' });
    await call(mcp, 'transition_problem', { ref: p.ref, to: 'known_error', root_cause: 'Driver leak' });
    const res = await call(mcp, 'assess_known_error', { ref: p.ref, risk_level: 3, decision: 'accept', review_date: '2099-06-01' });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.data.ec_decision, 'accept');
    assert.equal(res.data.ec_review_date, '2099-06-01');
  });

  test('runs analyses and offers facilitation prompts', async () => {
    const { data: p } = await call(mcp, 'create_problem', { title: 'Cache stampede after deploy' });
    const started = await call(mcp, 'start_analysis', { ref: p.ref, technique: 'timeline' });
    assert.equal(started.isError, false, started.text);
    const id = started.data[0].id;
    const events = [{ at: '2026-10-01T10:00', kind: 'deployment', description: 'v2.3 deployed', reference: 'CHG1' }];
    const updated = await call(mcp, 'update_analysis', { ref: p.ref, analysis_id: id, data: { events }, conclusion: 'Cold cache' });
    assert.equal(updated.data.data.events[0].kind, 'deployment');
    assert.equal(updated.data.conclusion, 'Cold cache');

    const { prompts } = await mcp.listPrompts();
    assert.deepEqual(prompts.map((x) => x.name).sort(), ['five_whys', 'kepner_tregoe', 'major_problem_review', 'triage_problem']);
    const prompt = await mcp.getPrompt({ name: 'five_whys', arguments: { ref: p.ref.toLowerCase() } });
    assert.match((prompt.messages[0].content as any).text, new RegExp(p.ref));
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
