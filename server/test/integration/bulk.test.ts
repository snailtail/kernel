import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

describe('bulk actions on lists (#110)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, viewer: Client;
  const ids: Record<string, number> = {};
  let team: any;

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('viewer')]);
    for (const u of (await ownerQuery('SELECT id, username FROM users')).rows) ids[u.username] = u.id;
    team = (await admin.post('/api/teams', { name: 'Network' })).body;
    await admin.put(`/api/teams/${team.id}/members`, { members: [{ user_id: ids.analyst, role: 'lead' }, { user_id: ids.pm }] });
  });
  after(() => k?.close());

  const auditCount = async (type: string, action: string) => (await ownerQuery('SELECT count(*)::int AS n FROM audit_log WHERE entity_type = $1 AND action = $2', [type, action])).rows[0].n;

  test('100 incidents: a preview changes nothing; applying writes 100 audit entries; undo puts them back', async () => {
    const refs: string[] = [];
    for (let n = 0; n < 100; n++) refs.push((await analyst.post('/api/incidents', { title: `Bulk switch ${n}`, assignee_id: ids.analyst })).body.ref);
    const before = await auditCount('incident', 'update');

    const preview = (await analyst.post('/api/incidents/bulk', { ids: refs, operation: { op: 'assign', team_id: team.id }, dry_run: true })).body;
    assert.equal(preview.summary.would_change, 100);
    assert.equal(preview.undo, null);
    assert.equal(await auditCount('incident', 'update'), before, 'a preview changes nothing');

    const done = (await analyst.post('/api/incidents/bulk', { ids: refs, operation: { op: 'assign', team_id: team.id } })).body;
    assert.equal(done.summary.changed, 100);
    assert.equal(await auditCount('incident', 'update') - before, 100, 'one audit entry per incident, from the same service as a single edit');
    assert.equal(await auditCount('bulk', 'assign'), 1, 'and one entry tying the request together');
    const after = (await analyst.get(`/api/incidents/${refs[0]}`)).body;
    assert.equal(after.team_id, team.id);
    assert.equal(after.assignee_id, ids.analyst, 'the assignee is in the team, so they keep it');

    const again = (await analyst.post('/api/incidents/bulk', { ids: refs.slice(0, 3), operation: { op: 'assign', team_id: team.id } })).body;
    assert.equal(again.summary.unchanged, 3, 'already so');

    const undone = (await analyst.post('/api/incidents/bulk', done.undo)).body;
    assert.equal(undone.summary.changed, 100);
    assert.equal((await analyst.get(`/api/incidents/${refs[0]}`)).body.team_id, null);
  });

  test('outcomes per record: skipped when missing, failed with the rule that stopped it', async () => {
    const a = (await analyst.post('/api/incidents', { title: 'Printer offline' })).body.ref;
    await analyst.post(`/api/incidents/${a}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Cable' });
    await analyst.post(`/api/incidents/${a}/transition`, { to: 'closed' });
    const b = (await analyst.post('/api/incidents', { title: 'Printer jammed' })).body.ref;
    await analyst.post(`/api/incidents/${b}/transition`, { to: 'in_progress' });
    const res = (await analyst.post('/api/incidents/bulk', { ids: [a, b, 'INC999999'], operation: { op: 'status', to: 'resolved', details: { resolution_code: 'fixed', resolution: 'Restarted the spooler' } } })).body;
    const by = Object.fromEntries(res.results.map((r: any) => [r.id, r]));
    assert.equal(by.INC999999.outcome, 'skipped');
    assert.equal(by[b].outcome, 'changed');
    assert.equal(by[a].outcome, 'failed', 'a closed incident stays closed');
    assert.match(by[a].reason, /cannot move from closed to resolved/);
    assert.equal(res.undo, null, 'status changes are not undone in bulk');

    const missing = (await analyst.post('/api/incidents/bulk', { ids: [(await analyst.post('/api/incidents', { title: 'Scanner' })).body.ref], operation: { op: 'status', to: 'on_hold' } })).body;
    assert.match(missing.results[0].reason, /reason/, 'the transition asks for its own details');
  });

  test('a filter selects the records, as a saved view would; limits and permissions hold', async () => {
    const p = (await pm.post('/api/problems', { title: 'Bulk prio source', impact: 3, urgency: 3 })).body.ref;
    const res = (await pm.post('/api/problems/bulk', { filter: 'q=prio&status=open', operation: { op: 'priority', impact: 1 } })).body;
    assert.deepEqual(res.results.map((r: any) => r.id), [p]);
    assert.equal((await pm.get(`/api/problems/${p}`)).body.impact, 1);
    assert.deepEqual(res.undo.items, [{ id: p, operation: { op: 'priority', impact: 3 } }]);

    assert.equal((await viewer.post('/api/problems/bulk', { ids: [p], operation: { op: 'priority', impact: 2 } })).status, 403);
    assert.equal((await pm.post('/api/problems/bulk', { ids: [p], operation: { op: 'acknowledge' } })).status, 400, 'not an operation for problems');
    assert.equal((await pm.post('/api/problems/bulk', { ids: Array.from({ length: 501 }, (_, n) => `PRB${n}`), operation: { op: 'priority', impact: 2 } })).status, 400);
    assert.equal((await pm.post('/api/problems/bulk', { operation: { op: 'priority', impact: 2 } })).status, 400, 'ids or a filter');
  });

  test('restricted records are skipped for those who cannot see them (#53)', async () => {
    const hidden = (await pm.post('/api/incidents', { title: 'Investigation' })).body.ref;
    await pm.put(`/api/records/${hidden}/visibility`, { restricted: true, reason: 'Security investigation' });
    const res = (await analyst.post('/api/incidents/bulk', { ids: [hidden], operation: { op: 'priority', impact: 1 } })).body;
    assert.equal(res.results[0].outcome, 'skipped');
    assert.equal(res.results[0].title, undefined, 'nothing about it is shown');
  });

  test('link to a problem or a parent incident, through the same paths as single links', async () => {
    const problem = (await pm.post('/api/problems', { title: 'Flaky DNS' })).body.ref;
    const parent = (await pm.post('/api/incidents', { title: 'DNS outage', impact: 1, urgency: 1 })).body.ref;
    await pm.post(`/api/incidents/${parent}/major`, {});
    const kids = [(await analyst.post('/api/incidents', { title: 'Cannot resolve intranet' })).body.ref, (await analyst.post('/api/incidents', { title: 'Mail bounces' })).body.ref];
    const linked = (await analyst.post('/api/incidents/bulk', { ids: kids, operation: { op: 'link_problem', problem } })).body;
    assert.equal(linked.summary.changed, 2);
    assert.equal((await analyst.get(`/api/incidents/${kids[0]}`)).body.problem_ref, problem);
    assert.deepEqual(linked.undo.items[0].operation, { op: 'link_problem', problem: null });
    const related = (await analyst.post('/api/incidents/bulk', { ids: kids, operation: { op: 'set_parent', parent } })).body;
    assert.equal(related.summary.changed, 2);
    assert.equal(related.undo, null);
    assert.equal((await analyst.post('/api/incidents/bulk', { ids: [parent], operation: { op: 'set_parent', parent } })).body.results[0].outcome, 'failed', 'not to itself');
  });

  test('alerts are acknowledged and closed', async () => {
    await analyst.post('/api/events', { source: 'bulk', events: [{ host: 'bulk-01', check: 'disk', severity: 'major' }, { host: 'bulk-02', check: 'disk', severity: 'minor' }] });
    const alerts = (await analyst.get('/api/alerts?q=bulk')).body.map((a: any) => a.id);
    assert.equal(alerts.length, 2);
    assert.equal((await analyst.post('/api/alerts/bulk', { ids: alerts, operation: { op: 'acknowledge' } })).body.summary.changed, 2);
    assert.equal((await analyst.post('/api/alerts/bulk', { filter: 'q=bulk', operation: { op: 'close' } })).body.summary.changed, 2);
    assert.equal((await analyst.get('/api/alerts?q=bulk')).body.length, 0);
    assert.equal(await auditCount('alert', 'close'), 2);
    assert.equal((await analyst.post(`/api/alerts/${alerts[0]}/close`, {})).status, 409, 'already closed');
  });

  test('actions get an owner and a status; CIs get tags', async () => {
    const p = (await pm.post('/api/problems', { title: 'Patch the switches' })).body.ref;
    await pm.post(`/api/problems/${p}/actions`, { title: 'Order firmware' });
    await pm.post(`/api/problems/${p}/actions`, { title: 'Plan window' });
    const acts = (await ownerQuery('SELECT a.id FROM problem_actions a JOIN problems p ON p.id = a.problem_id WHERE p.ref = $1', [p])).rows.map((r: any) => r.id);
    const res = (await pm.post('/api/actions/bulk', { ids: acts, operation: { op: 'assign', assignee_id: ids.analyst } })).body;
    assert.equal(res.summary.changed, 2);
    assert.equal((await pm.post('/api/actions/bulk', { ids: acts, operation: { op: 'status', to: 'done' } })).body.summary.changed, 2);

    const cis = [(await pm.post('/api/cis', { name: 'edge-sw01', ci_type: 'network_device', tags: ['legacy'] })).body.ref, (await pm.post('/api/cis', { name: 'edge-sw02', ci_type: 'network_device' })).body.ref];
    const tagged = (await pm.post('/api/cis/bulk', { ids: cis, operation: { op: 'tags', add: ['edge'], remove: ['legacy'] } })).body;
    assert.equal(tagged.summary.changed, 2);
    assert.deepEqual((await pm.get(`/api/cis/${cis[0]}`)).body.tags, ['edge']);
    await pm.post('/api/cis/bulk', tagged.undo);
    assert.deepEqual((await pm.get(`/api/cis/${cis[0]}`)).body.tags, ['legacy'], 'undo restores exactly what was there');
    assert.deepEqual((await pm.get(`/api/cis/${cis[1]}`)).body.tags, []);
  });

  test('MCP bulk_update previews by default and leaves decisions to their own tools', async () => {
    const mcp = new McpClient({ name: 'bulk', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('pm')}` } } }));
    const call = async (args: Record<string, unknown>) => {
      const res: any = await mcp.callTool({ name: 'bulk_update', arguments: args });
      if (res.isError) throw new Error(res.content[0].text);
      return JSON.parse(res.content[0].text);
    };
    try {
      const p = (await pm.post('/api/problems', { title: 'Agent bulk target', impact: 3 })).body.ref;
      const preview = await call({ practice: 'problems', ids: [p], operation: { op: 'priority', impact: 2 } });
      assert.equal(preview.dry_run, true);
      assert.equal(preview.summary.would_change, 1);
      assert.equal((await pm.get(`/api/problems/${p}`)).body.impact, 3, 'nothing changed without apply');
      assert.equal((await call({ practice: 'problems', ids: [p], operation: { op: 'priority', impact: 2 }, apply: true })).summary.changed, 1);
      await assert.rejects(call({ practice: 'problems', ids: [p], operation: { op: 'status', to: 'closed' }, apply: true }), /decision/);
    } finally {
      await mcp.close();
    }
  });
});
