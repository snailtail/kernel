import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

describe('saved list views (#110)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, analyst2: Client, viewer: Client;
  const ids: Record<string, number> = {};
  let db: typeof import('../../src/db.js');
  let team: any;

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst, analyst2, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('analyst2'), k.login('viewer')]);
    db = await import('../../src/db.js');
    for (const u of (await db.query('SELECT id, username FROM users')).rows) ids[u.username] = u.id;
    team = (await admin.post('/api/teams', { name: 'Service desk' })).body;
    await admin.put(`/api/teams/${team.id}/members`, { members: [{ user_id: ids.analyst, role: 'lead' }, { user_id: ids.analyst2 }] });
  });
  after(() => k?.close());

  const names = async (c: Client, list: string) => (await c.get(`/api/views?list=${list}`)).body.views.map((v: any) => v.name);

  test('every list has built-in views, and personal views are the owner’s alone', async () => {
    const incidents = (await analyst.get('/api/views?list=incidents')).body;
    assert.deepEqual(incidents.views.filter((v: any) => v.scope === 'builtin').map((v: any) => v.name), ["My team's queue", 'Unassigned P1–P2', 'Breaching SLA']);
    assert.equal(incidents.default, null);
    assert.equal((await analyst.get('/api/views?list=nonsense')).status, 400);

    const mine = await analyst.post('/api/views', { list: 'incidents', name: 'Printers', query: 'q=printer&status=all', columns: ['ref', 'title'] });
    assert.equal(mine.status, 201);
    assert.equal(mine.body.scope, 'personal');
    assert.equal(mine.body.can_edit, true);
    assert.equal((await analyst.post('/api/views', { list: 'incidents', name: 'printers', query: '' })).status, 409, 'names are unique per person and list');
    assert.ok(!(await names(analyst2, 'incidents')).includes('Printers'), 'nobody else sees it');
    assert.equal((await analyst2.patch(`/api/views/${mine.body.id}`, { name: 'Mine now' })).status, 404);
    assert.equal((await analyst2.del(`/api/views/${mine.body.id}`)).status, 404);
    const renamed = await analyst.patch(`/api/views/${mine.body.id}`, { name: 'Printer queue' });
    assert.equal(renamed.body.name, 'Printer queue');
    assert.equal(renamed.body.query, 'q=printer&status=all', 'unchanged fields stay');
    const audited = (await db.query("SELECT 1 FROM audit_log WHERE entity_type = 'list_view'")).rowCount;
    assert.equal(audited, 0, 'personal views are preferences, not audited');
  });

  test('team views belong to the team: members see them, leads edit them, and it is audited', async () => {
    assert.equal((await analyst2.post('/api/views', { list: 'incidents', name: 'Desk P1', query: 'max_priority=1', scope: 'team', team_id: team.id })).status, 403, 'a member is not a lead');
    assert.equal((await analyst.post('/api/views', { list: 'incidents', name: 'No team', scope: 'team' })).status, 400);
    const shared = (await analyst.post('/api/views', { list: 'incidents', name: 'Desk P1', query: 'max_priority=1', scope: 'team', team_id: team.id })).body;
    assert.equal(shared.team, 'Service desk');
    const seen = (await analyst2.get('/api/views?list=incidents')).body.views.find((v: any) => v.id === shared.id);
    assert.equal(seen.can_edit, false, 'members use it, leads change it');
    assert.ok(!(await names(pm, 'incidents')).includes('Desk P1'), 'not outside the team');
    assert.ok((await names(admin, 'incidents')).includes('Desk P1'), 'administrators see every team view');
    assert.equal((await analyst2.patch(`/api/views/${shared.id}`, { query: 'max_priority=2' })).status, 403);
    assert.equal((await admin.patch(`/api/views/${shared.id}`, { query: 'max_priority=2' })).status, 200);
    assert.equal((await analyst.del(`/api/views/${shared.id}`)).status, 200);
    const trail = (await db.query("SELECT action, changes FROM audit_log WHERE entity_type = 'list_view' ORDER BY id")).rows;
    assert.deepEqual(trail.map((r: any) => r.action), ['create', 'update', 'delete']);
    assert.equal(trail[1].changes.query.to.changed, true, 'the query is recorded as changed (it may hold search text, so not verbatim)');
  });

  test('views shared with everyone are for problem managers to make', async () => {
    assert.equal((await analyst.post('/api/views', { list: 'problems', name: 'All majors', query: 'is_major=true', scope: 'everyone' })).status, 403);
    const all = (await pm.post('/api/views', { list: 'problems', name: 'Majors by update', query: 'is_major=true&sort=updated', scope: 'everyone' })).body;
    assert.ok((await names(viewer, 'problems')).includes('Majors by update'));
    assert.equal((await viewer.del(`/api/views/${all.id}`)).status, 403);
    // A view cannot be smuggled into everyone's lists by changing its scope.
    const own = (await analyst.post('/api/views', { list: 'problems', name: 'Mine', query: 'assignee_id=1' })).body;
    assert.equal((await analyst.patch(`/api/views/${own.id}`, { scope: 'everyone' })).status, 403);
  });

  test('a view or a built-in one can be pinned as the default', async () => {
    assert.equal((await analyst.put('/api/views/default', { list: 'incidents', view: 'builtin:breaching-sla' })).status, 200);
    let body = (await analyst.get('/api/views?list=incidents')).body;
    assert.equal(body.default, 'builtin:breaching-sla');
    assert.ok(body.views.find((v: any) => v.key === 'builtin:breaching-sla').is_default);
    assert.equal((await analyst.put('/api/views/default', { list: 'incidents', view: 'builtin:nope' })).status, 400);
    const other = (await analyst2.post('/api/views', { list: 'incidents', name: 'Theirs', query: 'status=all' })).body;
    assert.equal((await analyst.put('/api/views/default', { list: 'incidents', view: other.id })).status, 404, "not someone else's view");
    const own = (await analyst.post('/api/views', { list: 'changes', name: 'Normal', query: 'type=normal' })).body;
    assert.equal((await analyst.put('/api/views/default', { list: 'incidents', view: own.id })).status, 400, 'the view must be for that list');
    await analyst.put('/api/views/default', { list: 'changes', view: own.id });
    assert.equal((await analyst.get('/api/views?list=changes')).body.default, String(own.id));
    await analyst.del(`/api/views/${own.id}`);
    assert.equal((await analyst.get('/api/views?list=changes')).body.default, null, 'removing the view clears the default');
  });

  test('the Unassigned P1–P2 view filters what it says', async () => {
    const p1 = (await analyst.post('/api/incidents', { title: 'Everything down', impact: 1, urgency: 1 })).body;
    const p3 = (await analyst.post('/api/incidents', { title: 'One printer', impact: 2, urgency: 2 })).body;
    const refs = (await analyst.get('/api/incidents?assignee=none&max_priority=2')).body.map((i: any) => i.ref);
    assert.ok(refs.includes(p1.ref));
    assert.ok(!refs.includes(p3.ref));
  });

  test('views saved in preferences move to the table', async () => {
    const sql = (await readFile(new URL('../../migrations/133_list_views.sql', import.meta.url), 'utf8')).split('-- Views users saved')[1];
    await ownerQuery(`UPDATE users SET preferences = preferences || $2 WHERE id = $1`, [
      ids.viewer,
      { theme: 'dark', saved_views: [{ name: 'Known errors', page: 'problems', query: 'status=known_error' }, { name: ' ', page: 'problems', query: '' }, { name: 'Odd', page: 'nowhere', query: '' }] },
    ]);
    await ownerQuery(sql.slice(sql.indexOf('\n')));
    const views = (await viewer.get('/api/views?list=problems')).body.views.filter((v: any) => v.scope === 'personal');
    assert.deepEqual(views.map((v: any) => [v.name, v.query]), [['Known errors', 'status=known_error']]);
    const prefs = (await viewer.get('/api/auth/me')).body.preferences;
    assert.equal(prefs.saved_views, undefined);
    assert.equal(prefs.theme, 'dark', 'other preferences stay');
  });

  test('MCP tools list, save and pin views', async () => {
    const mcp = new McpClient({ name: 'views', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const res: any = await mcp.callTool({ name, arguments: args });
      if (res.isError) throw new Error(res.content[0].text);
      return JSON.parse(res.content[0].text);
    };
    try {
      const saved = await call('save_view', { list: 'alerts', name: 'Database alerts', query: 'q=database' });
      assert.equal(saved.scope, 'personal');
      assert.ok((await call('list_views', { list: 'alerts' })).views.some((v: any) => v.id === saved.id));
      assert.equal((await call('save_view', { id: saved.id, name: 'DB alerts' })).name, 'DB alerts');
      assert.equal((await call('set_default_view', { list: 'alerts', view: saved.id })).default, String(saved.id));
      await call('delete_view', { id: saved.id });
      await assert.rejects(call('save_view', { name: 'No list' }), /list/);
    } finally {
      await mcp.close();
    }
  });
});
