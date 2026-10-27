// Development and service management (#167, part 1): a problem's fix type, a bug from a problem or an incident, a
// story from an improvement, typed links from either side, and the trace with a restricted link.
import assert from 'node:assert/strict';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: any }, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const userId = async (username: string) => (await ownerQuery('SELECT id FROM users WHERE username = $1', [username])).rows[0].id as number;

describe('development and service management (#167)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, analyst2: Client, viewer: Client;
  let team: { id: number };

  /** A known error with a decision to fix it. */
  const knownError = async (title: string, c = analyst) => {
    const p = ok(await c.post('/api/problems', { title, description: 'Exports time out at month end' }), 201).ref as string;
    ok(await c.post(`/api/problems/${p}/transition`, { to: 'analysis' }));
    ok(await c.post(`/api/problems/${p}/transition`, { to: 'known_error', root_cause: 'An N+1 query in the export', workaround: 'Export per department' }));
    ok(await pm.put(`/api/problems/${p}/assessment`, { ec_decision: 'fix' }));
    return p;
  };

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst, analyst2, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('analyst2'), k.login('viewer')]);
    ok(await admin.put('/api/admin/modules', { development: true, reason: 'Teams build what they run' }));
    team = ok(await admin.post('/api/teams', { name: 'Payroll devs' }), 201);
    ok(await admin.put(`/api/teams/${team.id}/members`, { members: [{ user_id: await userId('analyst') }] }));
  });
  after(async () => k?.close());

  test('the fix type decides the hand-over: only a code fix suggests a bug', async () => {
    const p = await knownError('Payroll export times out');
    assert.equal(ok(await analyst.get(`/api/problems/${p}`)).next_steps.handover.action, 'raise_change', 'no fix type yet: a change');
    assert.equal((await analyst.patch(`/api/problems/${p}`, { fix_type: 'rewrite' })).status, 400);
    let r = ok(await analyst.patch(`/api/problems/${p}`, { fix_type: 'configuration' }));
    assert.equal(r.fix_type, 'configuration');
    assert.equal(r.next_steps.handover.action, 'raise_change');
    r = ok(await analyst.patch(`/api/problems/${p}`, { fix_type: 'code' }));
    assert.equal(r.next_steps.handover.action, 'create_bug');
    assert.deepEqual(r.work_items, []);
    assert.ok(r.next_steps.steps.some((s: any) => s.id === 'fix_type' && s.done));
  });

  test('a bug from a problem carries the root cause and workaround, links both ways and is logged on the problem', async () => {
    const p = await knownError('Leave balance shows zero');
    ok(await analyst.patch(`/api/problems/${p}`, { fix_type: 'code' }));
    assert.equal((await viewer.post(`/api/records/${p}/work-items`, {})).status, 403);
    assert.equal((await analyst.post(`/api/records/${p}/work-items`, { type: 'story' })).status, 400, 'a problem becomes a bug');
    const bug = ok(await analyst.post(`/api/records/${p}/work-items`, { team_id: team.id, points: 3 }), 201);
    assert.equal(bug.item_type, 'bug');
    assert.equal(bug.title, 'Leave balance shows zero');
    assert.equal(bug.team_id, team.id);
    assert.match(bug.description, /Root cause:\nAn N\+1 query in the export/);
    assert.match(bug.description, /Workaround:\nExport per department/);
    assert.match(bug.description, new RegExp(`Raised from problem ${p}`));
    assert.deepEqual(bug.links.map((l: any) => [l.kind, l.reference, l.title]), [['problem', p, 'Leave balance shows zero']]);
    assert.equal(bug.activity.at(-1).body, `Created from ${p}`);

    const prb = ok(await analyst.get(`/api/problems/${p}`));
    assert.deepEqual(prb.work_items.map((w: any) => [w.ref, w.status, w.team]), [[bug.ref, 'new', 'Payroll devs']]);
    assert.equal(prb.next_steps.handover.label, 'The fix is planned', 'the known error stays while the bug is open');
    assert.ok(prb.activity.some((a: any) => a.body === `Bug ${bug.ref} created for the fix`));
  });

  test('a confidential problem: its text stays behind for someone not on it, and the bug starts confidential', async () => {
    const p = await knownError('Salary file exposed', analyst2);
    ok(await analyst2.put(`/api/records/${p}/classification`, { classification: 'confidential', reason: 'Personal data' }));
    const bug = ok(await analyst.post(`/api/records/${p}/work-items`, {}), 201);
    assert.equal(bug.classification, 'confidential');
    const { rows } = await ownerQuery('SELECT description FROM work_items WHERE ref = $1', [bug.ref]);
    assert.doesNotMatch(rows[0].description, /N\+1/, 'the root cause was not copied');
    assert.match(rows[0].description, /confidential, its text is not included/);
    const mine = ok(await analyst2.post(`/api/records/${p}/work-items`, {}), 201);
    assert.match((await ownerQuery('SELECT description FROM work_items WHERE ref = $1', [mine.ref])).rows[0].description, /N\+1/, 'its owner copies it');
  });

  test('a bug from an incident, a story from an improvement', async () => {
    const inc = ok(await analyst.post('/api/incidents', { title: 'Payslip PDF is blank', description: 'Blank page in Firefox' }), 201).ref;
    const bug = ok(await analyst.post(`/api/records/${inc}/work-items`, {}), 201);
    assert.equal(bug.item_type, 'bug');
    assert.equal(bug.actual_result, 'Blank page in Firefox');
    assert.deepEqual(bug.links.map((l: any) => l.reference), [inc]);
    const imp = ok(await analyst.post('/api/improvements', { title: 'Self-service payslips', description: 'Fewer calls to HR' }), 201).ref;
    const story = ok(await analyst.post(`/api/records/${imp}/work-items`, {}), 201);
    assert.equal(story.item_type, 'story');
    assert.match(story.description, /Fewer calls to HR/);
    assert.equal(ok(await analyst.post(`/api/records/${imp}/work-items`, { type: 'epic' }), 201).item_type, 'epic');
    assert.equal((await analyst.post(`/api/records/${bug.ref}/work-items`, {})).status, 400, 'not from a work item');
  });

  test('link_records from either side, checked against the kind and visibility', async () => {
    const p = ok(await analyst.post('/api/problems', { title: 'Linked problem' }), 201).ref;
    const story = ok(await analyst.post('/api/work-items', { type: 'story', title: 'Linked story' }), 201).ref;
    ok(await analyst.post(`/api/records/${p}/links`, { to: story }));
    let w = ok(await analyst.get(`/api/work-items/${story}`));
    assert.deepEqual(w.links.map((l: any) => [l.kind, l.reference]), [['problem', p]]);
    const chg = ok(await pm.post('/api/changes', { title: 'Deploy the fix' }), 201).ref;
    ok(await analyst.post(`/api/records/${story}/links`, { to: chg }));
    w = ok(await analyst.get(`/api/work-items/${story}`));
    assert.deepEqual(w.links.map((l: any) => l.kind).sort(), ['change', 'problem']);
    assert.equal((await analyst.post(`/api/work-items/${story}/links`, { kind: 'problem', reference: chg })).status, 400, 'a change is not a problem');
    const hidden = ok(await analyst2.post('/api/problems', { title: 'Hidden problem' }), 201).ref;
    ok(await analyst2.put(`/api/records/${hidden}/visibility`, { restricted: true, reason: 'Security' }));
    assert.equal((await analyst.post(`/api/work-items/${story}/links`, { kind: 'problem', reference: hidden })).status, 404, 'like one that does not exist');
  });

  test('the trace: incident → problem → bug → change, a restricted link without its ref, and MCP', async () => {
    const inc = ok(await analyst.post('/api/incidents', { title: 'Payroll run failed' }), 201).ref;
    const p = ok(await analyst.post(`/api/incidents/${inc}/problem`, {}), 201).ref;
    ok(await analyst.patch(`/api/problems/${p}`, { fix_type: 'code' }));
    const bug = ok(await analyst.post(`/api/records/${p}/work-items`, {}), 201).ref;
    const chg = ok(await pm.post('/api/changes', { title: 'Release 4.2' }), 201).ref;
    ok(await analyst.post(`/api/records/${bug}/links`, { to: chg }));
    // A second incident only analyst2 may see.
    const secret = ok(await analyst2.post('/api/incidents', { title: 'Secret payroll incident' }), 201).ref;
    ok(await analyst2.put(`/api/records/${secret}/visibility`, { restricted: true, reason: 'HR case' }));
    ok(await analyst2.post(`/api/records/${secret}/links`, { to: p, kind: 'problem' }));

    for (const from of [inc, chg]) {
      const t = ok(await analyst.get(`/api/records/${from}/trace`));
      assert.equal(t.ref, from);
      const refs = t.nodes.filter((n: any) => !n.restricted).map((n: any) => n.ref).sort();
      assert.deepEqual(refs, [inc, p, bug, chg].sort(), `from ${from}`);
      const hidden = t.nodes.filter((n: any) => n.restricted);
      assert.deepEqual(hidden.map((n: any) => [n.type, n.ref, n.title]), [['incident', undefined, undefined]]);
      assert.ok(t.edges.some((e: any) => e.from === hidden[0].id || e.to === hidden[0].id), 'linked to the problem');
      assert.ok(!JSON.stringify(t).includes(secret) && !JSON.stringify(t).includes('Secret payroll'));
      assert.ok(t.nodes.find((n: any) => n.ref === bug).item_type === 'bug');
    }
    const all = ok(await analyst2.get(`/api/records/${p}/trace`));
    assert.ok(all.nodes.some((n: any) => n.ref === secret), 'its own people see it');
    assert.equal((await viewer.get(`/api/records/${secret}/trace`)).status, 404);

    const mcp = new McpClient({ name: 'trace', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    try {
      const res: any = await mcp.callTool({ name: 'get_record_trace', arguments: { ref: p } });
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.nodes.length, 5);
      assert.equal(body.nodes.find((n: any) => n.ref === p).title, undefined, 'titles are untrusted content');
      assert.equal(body.untrusted_content.titles[p], 'Payroll run failed');
      const made: any = await mcp.callTool({ name: 'create_work_item_from', arguments: { ref: inc } });
      assert.equal(JSON.parse(made.content[0].text).item_type, 'bug');
    } finally {
      await mcp.close();
    }

    // With the module off, work items leave the trace and making one is gone.
    ok(await admin.put('/api/admin/modules', { development: false, reason: 'Off' }));
    try {
      const t = ok(await analyst.get(`/api/records/${p}/trace`));
      assert.ok(!t.nodes.some((n: any) => n.type === 'work_item'));
      assert.equal((await analyst.post(`/api/records/${p}/work-items`, {})).status, 404);
      assert.equal(ok(await analyst.get(`/api/problems/${p}`)).work_items, undefined);
    } finally {
      ok(await admin.put('/api/admin/modules', { development: true, reason: 'On' }));
    }
  });
});
