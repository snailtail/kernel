// Actions as their own register (#184): the migration keeps every action, an action hangs off any record kind, and
// it is as visible as its parent.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, TEST_DATABASE_URL, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: unknown }) => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);

describe('migration 157: problem actions become the actions register', { skip }, () => {
  test('every action keeps its id, fields and history, as an action on its problem', async () => {
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    try {
      await c.query('DROP SCHEMA IF EXISTS reporting CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      const dir = new URL('../../migrations/', import.meta.url);
      const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
      const at = files.indexOf('157_actions.sql');
      for (const f of files.slice(0, at)) await c.query(await readFile(new URL(f, dir), 'utf8'));
      const u = (await c.query("INSERT INTO users (username, display_name, password_hash, role) VALUES ('mig', 'Mig', 'x', 'analyst') RETURNING id")).rows[0].id;
      const p = (await c.query("INSERT INTO problems (title, created_by) VALUES ('Leaking pool', $1) RETURNING id, ref", [u])).rows[0];
      const a = (await c.query(
        `INSERT INTO problem_actions (problem_id, title, description, owner_id, due_date, status, change_ref, created_by, completed_at)
         VALUES ($1, 'Vendor patch', 'Ask the vendor', $2, '2026-11-01', 'done', 'CHG000001', $2, now()), ($1, 'Add alerting', '', NULL, NULL, 'open', '', $2, NULL)
         RETURNING *`,
        [p.id, u],
      )).rows;
      await c.query("INSERT INTO problem_activity (problem_id, user_id, kind, body, data) VALUES ($1, $2, 'action', 'Added action: Vendor patch', $3)", [p.id, u, { action_id: a[0].id, change: 'added' }]);
      const before = (await c.query('SELECT * FROM problem_actions ORDER BY id')).rows;

      await c.query(await readFile(new URL('157_actions.sql', dir), 'utf8'));

      const after = (await c.query('SELECT * FROM actions ORDER BY id')).rows;
      assert.equal(after.length, before.length);
      for (const [i, row] of before.entries()) {
        const { problem_id, ...fields } = row;
        assert.deepEqual({ ...after[i], parent_kind: undefined, parent_id: undefined }, { ...fields, parent_kind: undefined, parent_id: undefined });
        assert.deepEqual([after[i].parent_kind, after[i].parent_id], ['problem', problem_id]);
      }
      const history = (await c.query("SELECT data FROM problem_activity WHERE problem_id = $1 AND kind = 'action'", [p.id])).rows;
      assert.deepEqual(history.map((h) => h.data.action_id), [a[0].id], 'the history is where it was');
      const next = (await c.query("INSERT INTO actions (parent_kind, parent_id, title, created_by) VALUES ('problem', $1, 'Next', $2) RETURNING id", [p.id, u])).rows[0].id;
      assert.ok(next > a[1].id, 'the id sequence carries on');
      await c.query('DELETE FROM problems WHERE id = $1', [p.id]);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM actions')).rows[0].n, 0, 'a removed parent takes its actions');
    } finally {
      await c.end();
    }
  });
});

describe('actions on any record (#184)', { skip }, () => {
  let k: Harness;
  let pm: Client, analyst: Client, analyst2: Client, admin: Client, viewer: Client;
  let inc = '', prb = '', pir = '';
  const ids: Record<string, number> = {};

  before(async () => {
    k = await startKernel();
    [pm, analyst, analyst2, admin, viewer] = await Promise.all([k.login('pm'), k.login('analyst'), k.login('analyst2'), k.login('admin'), k.login('viewer')]);
    for (const u of (await ownerQuery('SELECT id, username FROM users')).rows) ids[u.username] = u.id;
    inc = (await analyst.post('/api/incidents', { title: 'Mail queue stuck', impact: 2, urgency: 2 })).body.ref;
    prb = (await analyst.post('/api/problems', { title: 'Mail relay leaks connections' })).body.ref;
    pir = (await pm.post(`/api/incidents/${inc}/review`, {})).body.ref;
  });
  after(async () => k?.close());

  test('an action on an incident: created, listed, changed, and in the incident history', async () => {
    const created = await analyst.post('/api/actions', { parent: inc, title: 'Add a queue-length alert', owner_id: ids.analyst2, due_date: '2026-12-01' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const a = created.body;
    assert.deepEqual([a.parent_kind, a.ref, a.parent_title, a.path, a.problem_id], ['incident', inc, 'Mail queue stuck', `/incidents/${inc}`, null]);
    const listed = (await analyst.get(`/api/actions?parent=${inc}`)).body;
    assert.deepEqual(listed.map((x: any) => x.id), [a.id]);
    assert.ok((await analyst2.get('/api/my-work')).body.actions.some((x: any) => x.id === a.id), "in the owner's My Work");
    const done = await analyst.patch(`/api/actions/${a.id}`, { status: 'done' });
    ok(done);
    assert.equal(done.body.status, 'done');
    assert.ok(done.body.completed_at);
    const history = (await analyst.get(`/api/incidents/${inc}`)).body.activity.filter((e: any) => e.kind === 'action').map((e: any) => e.body);
    assert.deepEqual(history.sort(), ['Added action: Add a queue-length alert', 'Completed action: Add a queue-length alert']);
    assert.equal((await viewer.post('/api/actions', { parent: inc, title: 'x' })).status, 403);
    assert.equal((await analyst.post('/api/actions', { parent: 'INC999999', title: 'x' })).status, 404, 'no such record');
    assert.equal((await analyst.post('/api/actions', { parent: 'CI000001', title: 'x' })).status, 400, 'not a kind that takes actions');
    assert.equal((await analyst.get('/api/actions/999999')).status, 404);
    assert.equal((await analyst.get('/api/actions/nope')).status, 404);
  });

  test('an action on a post-incident review needs no problem; its history is the incident\'s', async () => {
    const r = (await analyst.post(`/api/incidents/${inc}/review/items`, { kind: 'follow_up', body: 'Document the relay restart' })).body;
    const item = r.items.find((x: any) => x.kind === 'follow_up');
    const after = (await analyst.post(`/api/incidents/${inc}/review/items/${item.id}/action`, { owner_id: ids.analyst })).body;
    assert.equal(after.items.find((x: any) => x.id === item.id).action_parent_kind, 'review');
    assert.deepEqual(after.actions.map((x: any) => [x.parent_kind, x.ref, x.title]), [['review', pir, 'Document the relay restart']]);
    const entry = (await analyst.get(`/api/incidents/${inc}`)).body.activity.find((e: any) => e.kind === 'action' && /relay restart/.test(e.body));
    assert.equal(entry.data.review, pir);
    // Added straight on the review too, and listed by kind.
    ok(await analyst.post('/api/actions', { parent: pir, title: 'Share the review with the mail team' }));
    assert.equal((await analyst.get(`/api/actions?parent_kind=review&status=all`)).body.length, 2);
  });

  test('the problem routes stay as they were: they answer with the problem', async () => {
    const r = await analyst.post(`/api/problems/${prb}/actions`, { title: 'Patch the relay' });
    assert.equal(r.status, 201);
    assert.equal(r.body.ref, prb);
    const a = r.body.actions.find((x: any) => x.title === 'Patch the relay');
    assert.deepEqual([a.parent_kind, a.problem_id !== null, a.problem_title], ['problem', true, 'Mail relay leaks connections']);
    const p = await analyst.patch(`/api/problems/${prb}/actions/${a.id}`, { status: 'cancelled' });
    ok(p);
    assert.equal(p.body.actions.find((x: any) => x.id === a.id).status, 'cancelled');
    assert.equal((await analyst.post(`/api/problems/${inc}/actions`, { title: 'x' })).status, 404, 'only problems here');
    const other = (await analyst.get(`/api/actions?parent=${inc}&status=all`)).body[0];
    assert.equal((await analyst.patch(`/api/problems/${prb}/actions/${other.id}`, { title: 'y' })).status, 404, "another record's action");
  });

  test('improvements and changes take actions; the search covers the parent', async () => {
    const imp = (await pm.post('/api/improvements', { title: 'Self-service mail rules' })).body.ref;
    ok(await pm.post('/api/actions', { parent: imp, title: 'Pilot with the service desk' }));
    const detail = (await pm.get(`/api/improvements/${imp}`)).body;
    assert.deepEqual(detail.actions.map((x: any) => x.title), ['Pilot with the service desk']);
    const chg = (await pm.post('/api/changes', { title: 'Upgrade the relay' })).body.ref;
    ok(await pm.post('/api/actions', { parent: chg, title: 'Book the window' }));
    const found = (await pm.get('/api/actions?q=Upgrade the relay')).body;
    assert.deepEqual(found.map((x: any) => x.ref), [chg], 'matches the parent title');
  });

  test('an action is as visible as its parent', async () => {
    const sec = (await admin.post('/api/teams', { name: 'Mail security' })).body;
    ok(await admin.put(`/api/teams/${sec.id}/members`, { members: [{ user_id: ids.analyst, role: 'lead' }] }));
    const hidden = (await analyst.post('/api/incidents', { title: 'Phishing via relay' })).body.ref;
    const a = (await analyst.post('/api/actions', { parent: hidden, title: 'Block sender domain', owner_id: ids.analyst })).body;
    ok(await analyst.put(`/api/records/${hidden}/visibility`, { restricted: true, teams: [sec.id], reason: 'Security investigation' }));
    assert.equal((await analyst2.get(`/api/actions/${a.id}`)).status, 404);
    assert.equal((await analyst2.get('/api/actions?status=all&limit=500')).body.some((x: any) => x.id === a.id), false);
    assert.equal((await analyst2.patch(`/api/actions/${a.id}`, { status: 'done' })).status, 404);
    assert.equal((await analyst2.post('/api/actions', { parent: hidden, title: 'x' })).status, 404);
    // Positive control: the team sees it.
    assert.equal((await analyst.get(`/api/actions/${a.id}`)).status, 200);
  });

  test('due-date rules start from actions on incidents too', async () => {
    const r = await pm.post('/api/rules', {
      name: 'Incident follow-up due', kind: 'incident', trigger: { type: 'due_in', hours: 48 }, conditions: [],
      actions: [{ type: 'notify', roles: ['owner'] }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  test('MCP: add_action and list_actions work for any record', async () => {
    const client = new McpClient({ name: 'kernel-tests', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('pm')}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const res: any = await client.callTool({ name, arguments: args });
      assert.ok(!res.isError, res.content[0].text);
      return JSON.parse(res.content[0].text);
    };
    const added = await call('add_action', { ref: pir, title: 'Agent: check the relay runbook', owner: 'analyst' });
    assert.ok(added.some((x: any) => x.title === 'Agent: check the relay runbook' && x.parent_kind === 'review'));
    const id = added.find((x: any) => x.title === 'Agent: check the relay runbook').id;
    const updated = await call('update_action', { action_id: id, status: 'done' });
    assert.equal(updated.find((x: any) => x.id === id).status, 'done');
    const listed = await call('list_actions', { parent: inc, status: 'all' });
    assert.ok(listed.every((x: any) => x.ref === inc));
    await client.close();
  });
});
