import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: any }, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};

type Fields = Record<string, unknown>;

/** Azure DevOps' work item API on loopback, behind its own CA: WIQL (with UNDER on the area path) and the batch read. */
function fakeAzureDevOps(cert: string, key: string) {
  const items = new Map<number, Fields>();
  const seen: { path: string; auth: string }[] = [];
  let failing = false;
  const server: Server = createServer({ cert, key }, (req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? '') });
      const json = (body: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (failing) return json({ message: 'TF400813: not authorized' }, 401);
      const body = raw ? JSON.parse(raw) : {};
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'POST' && path === '/contoso/Web%20Shop/_apis/wit/wiql') {
        const under = String(body.query).match(/UNDER '((?:[^']|'')*)'/)?.[1].replaceAll("''", "'").toLowerCase();
        const ids = [...items].filter(([, f]) => !under || String(f['System.AreaPath']).toLowerCase() === under || String(f['System.AreaPath']).toLowerCase().startsWith(`${under}\\`)).map(([id]) => ({ id }));
        return json({ workItems: ids });
      }
      if (req.method === 'POST' && path === '/contoso/Web%20Shop/_apis/wit/workitemsbatch') {
        return json({ value: (body.ids as number[]).map((id) => (items.has(id) ? { id, fields: items.get(id) } : null)) });
      }
      return json({ message: 'Not found' }, 404);
    });
  });
  return { server, items, seen, fail: (v: boolean) => (failing = v), listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as any).port))) };
}

const AREA = 'Web Shop\\Platform';
const wi = (id: number, type: string, title: string, extra: Fields = {}): [number, Fields] => [id, {
  'System.Id': id, 'System.WorkItemType': type, 'System.Title': title, 'System.State': 'New', 'System.AreaPath': AREA, 'System.IterationPath': 'Web Shop', 'System.TeamProject': 'Web Shop',
  'System.Description': 'DESCRIPTION-NOT-COPIED', ...extra,
}];

describe('mirrored backlogs from Azure DevOps (part 1 of #168)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;
  let team: { id: number };
  let source: any;
  let ado: ReturnType<typeof fakeAzureDevOps>;
  let prb: string;
  const dir = mkdtempSync(join(tmpdir(), 'ado-'));
  const byExternal = async (id: number) => {
    const { rows } = await ownerQuery("SELECT ref FROM work_items WHERE source = 'azure_devops' AND external_id = $1", [`contoso#${id}`]);
    return rows[0] ? ok(await analyst.get(`/api/work-items/${rows[0].ref}`)) : undefined;
  };
  const sync = async () => ok(await pm.post(`/api/teams/${team.id}/mirror/sync`, {}));
  const activityCount = async () => Number((await ownerQuery('SELECT count(*) FROM work_item_activity')).rows[0].count);
  const basic = (password: string) => `Basic ${Buffer.from(`kernel:${password}`).toString('base64')}`;
  const hook = (eventType: string, resource: object, opts: { password?: string; id?: string } = {}) =>
    fetch(`${k.base}/api/dev-hooks/${source.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic(opts.password ?? source.webhook_secret) },
      body: JSON.stringify({ id: opts.id ?? randomUUID(), notificationId: 1, eventType, resourceContainers: { account: { baseUrl: 'https://dev.azure.com/contoso/' } }, resource }),
    }).then(async (r) => ({ status: r.status, body: await r.json() as any }));

  before(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k'), '-out', join(dir, 'c'), '-days', '1', '-subj', '/CN=ado', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    const ca = readFileSync(join(dir, 'c'), 'utf8');
    ado = fakeAzureDevOps(ca, readFileSync(join(dir, 'k'), 'utf8'));
    const port = await ado.listen();
    process.env.KERNEL_SECRET_KEY = 'work-item-mirror-test-key-0123456789abcdef';
    process.env.KERNEL_DEV_STATUS_FETCH = 'false';
    process.env.KERNEL_OUTBOUND_ALLOW = '127.0.0.1';
    process.env.KERNEL_DEV_HOOKS_ALLOW_HTTP = 'true';
    k = await startKernel();
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
    ok(await admin.put('/api/admin/modules', { development: true, reason: 'The platform team works in Azure DevOps' }));
    team = ok(await admin.post('/api/teams', { name: 'Platform' }), 201);
    source = ok(await pm.post('/api/dev-sources', { name: 'Azure DevOps', platform: 'azure_devops', repositories: ['contoso/Web Shop'], api_token: 'ado-pat' }), 201);
    // The source's API is the fake one, reached through the source's own CA.
    await ownerQuery('UPDATE dev_sources SET base_url = $2, ca_pem = $3 WHERE id = $1', [source.id, `https://127.0.0.1:${port}`, ca]);
    await ownerQuery("UPDATE users SET email = 'analyst@contoso.com' WHERE username = 'analyst'");
    prb = ok(await analyst.post('/api/problems', { title: 'Checkout times out' }), 201).ref;
    ok(await analyst.post('/api/sprints', { team_id: team.id, name: 'Sprint 1', starts_on: new Date().toISOString().slice(0, 10), ends_on: new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10) }), 201);
    for (const [id, f] of [
      wi(1, 'Epic', 'Faster checkout'),
      wi(2, 'User Story', 'Pay with one click', { 'System.Parent': 1, 'Microsoft.VSTS.Scheduling.StoryPoints': 4, 'System.AssignedTo': { displayName: 'Analyst', uniqueName: 'Analyst@contoso.com' }, 'System.IterationPath': 'Web Shop\\Sprint 1', 'System.State': 'Active' }),
      wi(3, 'Bug', 'Pool exhausted at checkout', { 'System.Parent': 1, 'System.State': 'Resolved' }),
      wi(4, 'Task', 'Raise the pool limit', { 'System.Parent': 2, 'System.State': 'Closed' }),
      wi(5, 'Issue', 'An impediment the team tracks there only'),
      wi(6, 'User Story', 'Another team\'s story', { 'System.AreaPath': 'Web Shop\\Payments' }),
    ] as [number, Fields][]) ado.items.set(id, f);
  });
  after(async () => {
    for (const v of ['KERNEL_SECRET_KEY', 'KERNEL_DEV_STATUS_FETCH', 'KERNEL_OUTBOUND_ALLOW', 'KERNEL_DEV_HOOKS_ALLOW_HTTP']) delete process.env[v];
    ado?.server.close();
    rmSync(dir, { recursive: true, force: true });
    await k?.close();
  });

  test('settings: managers choose the source, project and area; the project must be one of the source\'s', async () => {
    assert.deepEqual(ok(await analyst.get(`/api/teams/${team.id}/mirror`)).mirrored, false, 'native by default');
    const body = { source_id: source.id, scope: 'contoso/Web Shop', area: AREA, type_map: { Issue: '' } };
    assert.equal((await analyst.put(`/api/teams/${team.id}/mirror`, body)).status, 403);
    assert.equal((await pm.put(`/api/teams/${team.id}/mirror`, { ...body, scope: 'contoso/Other' })).status, 400);
    const gh = ok(await pm.post('/api/dev-sources', { name: 'GitHub', platform: 'github', repositories: ['acme/shop'] }), 201);
    assert.equal((await pm.put(`/api/teams/${team.id}/mirror`, { ...body, source_id: gh.id, scope: 'acme/shop' })).status, 400, 'GitHub comes in part 2');
    const m = ok(await pm.put(`/api/teams/${team.id}/mirror`, body));
    assert.equal(m.mirrored, true);
    assert.equal(m.default_types['user story'], 'story');
  });

  test('reconciliation: the mapping per type and state, points on Kernel\'s scale, parents, assignee and sprint; nothing else is read', async () => {
    const run = await sync();
    assert.equal(run.status, 'succeeded', run.message);
    assert.deepEqual(run.counts, { created: 4, updated: 0, unchanged: 0, skipped: 1, removed: 0 });
    assert.ok(ado.seen.every((s) => s.auth === `Basic ${Buffer.from(':ado-pat').toString('base64')}`), 'with the source token');
    const [epic, story, bug, task] = [await byExternal(1), await byExternal(2), await byExternal(3), await byExternal(4)];
    assert.equal(await byExternal(5), undefined, 'a type mapped to nothing is not mirrored');
    assert.equal(await byExternal(6), undefined, 'outside the area');
    assert.deepEqual([epic.item_type, story.item_type, bug.item_type, task.item_type], ['epic', 'story', 'bug', 'task']);
    assert.deepEqual([epic.status, story.status, bug.status, task.status], ['new', 'in_progress', 'in_review', 'done']);
    assert.equal(story.points, 5, '4 points become 5');
    assert.equal(story.parent.ref, epic.ref);
    assert.equal(task.parent.ref, story.ref);
    assert.equal(story.assignee, 'Analyst', 'matched by e-mail');
    assert.equal(story.sprint?.name, 'Sprint 1', 'the iteration names the team\'s sprint');
    assert.equal(story.team_id, team.id);
    assert.equal(story.description, '', 'the description stays in the source');
    assert.match(story.mirror.url, /\/contoso\/Web%20Shop\/_workitems\/edit\/2$/);
    assert.equal(story.mirror.label, 'Azure DevOps');
    assert.deepEqual(story.transitions, []);
    assert.equal(story.activity.at(-1).body, 'Mirrored from Azure DevOps');

    const before = await activityCount();
    assert.deepEqual((await sync()).counts, { created: 0, updated: 0, unchanged: 4, skipped: 1, removed: 0 }, 'idempotent');
    assert.equal(await activityCount(), before, 'an unchanged item logs nothing');

    ado.items.get(2)!['System.Title'] = 'Pay with one tap';
    ado.items.get(2)!['System.State'] = 'Resolved';
    assert.equal((await sync()).counts.updated, 1);
    const again = await byExternal(2);
    assert.equal(again.title, 'Pay with one tap');
    assert.equal(again.status, 'in_review');
    assert.ok(again.activity.some((a: any) => a.body === 'Updated in Azure DevOps: title'));

    // An adjusted mapping: this team counts Resolved as done.
    ok(await pm.put(`/api/teams/${team.id}/mirror`, { source_id: source.id, scope: 'contoso/Web Shop', area: AREA, type_map: { Issue: '' }, status_map: { resolved: 'done' } }));
    await sync();
    assert.deepEqual([(await byExternal(2)).status, (await byExternal(3)).status], ['done', 'done']);
    ok(await pm.put(`/api/teams/${team.id}/mirror`, { source_id: source.id, scope: 'contoso/Web Shop', area: AREA, type_map: { Issue: '' } }));
    await sync();
    assert.equal((await byExternal(2)).status, 'in_review');
  });

  test('the fields the source owns are read-only over REST and MCP; links, comments and the description stay Kernel\'s', async () => {
    const story = await byExternal(2);
    const refused = await analyst.patch(`/api/work-items/${story.ref}`, { title: 'Renamed here', points: 8 });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /mirrored from Azure DevOps, which owns its title, points: change them there/);
    assert.equal((await analyst.patch(`/api/work-items/${story.ref}`, { team_id: null })).status, 409);
    assert.equal((await analyst.post(`/api/work-items/${story.ref}/transition`, { to: 'done' })).status, 409);
    const sprints = ok(await analyst.get(`/api/sprints?team=${team.id}`));
    assert.equal((await analyst.post(`/api/sprints/${sprints[0].id}/items`, { remove: [story.ref] })).status, 409, 'its sprint is its iteration');
    ok(await analyst.patch(`/api/work-items/${story.ref}`, { title: story.title, description: 'Notes for Kernel', labels: ['checkout'] }), 200);
    ok(await analyst.post(`/api/work-items/${story.ref}/comments`, { body: 'Linked from the problem' }));
    ok(await analyst.post(`/api/work-items/${story.ref}/links`, { kind: 'problem', reference: prb }));
    const now = await byExternal(2);
    assert.equal(now.description, 'Notes for Kernel');
    assert.ok(now.links.some((l: any) => l.reference === prb), 'linked as for native items (#167)');

    const mcp = new McpClient({ name: 'mirror', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    try {
      const call = (name: string, args: object) => mcp.callTool({ name, arguments: args as Record<string, unknown> }) as Promise<any>;
      const got = JSON.parse((await call('get_work_item', { ref: story.ref })).content[0].text);
      assert.equal(got.mirror.source, 'azure_devops');
      assert.equal(got.untrusted_content.title, 'Pay with one tap', 'the source\'s title is untrusted content');
      assert.equal(got.title, undefined);
      const update = await call('update_work_item', { ref: story.ref, title: 'Renamed by an agent' });
      assert.ok(update.isError && /owns its title/.test(update.content[0].text));
      const move = await call('transition_work_item', { ref: story.ref, to: 'done' });
      assert.ok(move.isError && /owns its status/.test(move.content[0].text));
    } finally {
      await mcp.close();
    }
  });

  test('deleted in the source is removed with the reason, moved out of the area too; never deleted', async () => {
    const bug = await byExternal(3);
    ado.items.delete(3);
    ado.items.get(4)!['System.AreaPath'] = 'Web Shop\\Payments';
    const run = await sync();
    assert.equal(run.counts.removed, 2);
    const [gone, moved] = [await byExternal(3), await byExternal(4)];
    assert.equal(gone.status, 'removed');
    assert.equal(gone.remove_reason, 'Deleted in Azure DevOps');
    assert.equal(gone.ref, bug.ref);
    assert.equal(moved.status, 'removed');
    assert.equal(moved.remove_reason, 'Moved out of the mirrored area in Azure DevOps');
    assert.equal((await sync()).counts.removed, 0, 'once');
    ado.items.get(4)!['System.AreaPath'] = AREA;
    await sync();
    assert.equal((await byExternal(4)).status, 'done', 'back in the area, the source\'s state again');
  });

  test('a list that fails or shrank by more than half never removes anything', async () => {
    for (let id = 100; id < 112; id++) ado.items.set(...wi(id, 'User Story', `Story ${id}`));
    assert.equal((await sync()).counts.created, 12);
    ado.fail(true);
    const failed = await sync();
    assert.equal(failed.status, 'failed');
    assert.match(failed.message, /HTTP 401/);
    ado.fail(false);
    const saved = new Map(ado.items);
    for (let id = 100; id < 112; id++) ado.items.delete(id);
    ado.items.delete(1); ado.items.delete(2);
    const refused = await sync();
    assert.equal(refused.status, 'refused');
    assert.equal(refused.counts.removed, 0);
    assert.equal((await byExternal(100)).status, 'new');
    assert.equal(ok(await pm.get(`/api/teams/${team.id}/mirror`)).last_run.status, 'refused');
    for (const [id, f] of saved) ado.items.set(id, f);
    assert.equal((await sync()).status, 'succeeded');
  });

  test('webhook: a verified delivery updates, creates and removes; replays and bad credentials change nothing', async () => {
    const fields = (id: number) => ado.items.get(id)!;
    const update = (id: number, f: Fields, opts = {}) => hook('workitem.updated', { workItemId: id, revision: { id, fields: f } }, opts);
    const story = await byExternal(2);
    const changed = { ...fields(2), 'System.Title': 'Pay with a single tap', 'System.State': 'Closed', 'System.AssignedTo': 'Analyst <analyst@contoso.com>' };
    assert.equal((await update(2, changed, { password: 'wrong' })).status, 401);
    assert.equal((await byExternal(2)).title, story.title);
    const id = randomUUID();
    ok(await update(2, changed, { id }), 202);
    const after = await byExternal(2);
    assert.equal(after.title, 'Pay with a single tap');
    assert.equal(after.status, 'done');
    assert.equal(after.assignee, 'Analyst');
    const before = await activityCount();
    assert.equal(ok(await update(2, changed, { id }), 202).ignored, 'replayed delivery');
    ok(await update(2, changed), 202);
    assert.equal(await activityCount(), before, 'the same state again changes nothing');

    const created = wi(7, 'Bug', 'Found through the webhook', { 'System.Parent': 1 })[1];
    ok(await hook('workitem.created', { id: 7, fields: created }), 202);
    const bug = await byExternal(7);
    assert.equal(bug.item_type, 'bug');
    assert.equal(bug.parent.ref, (await byExternal(1)).ref);
    ok(await hook('workitem.created', { id: 8, fields: wi(8, 'Bug', 'Elsewhere', { 'System.AreaPath': 'Web Shop\\Payments' })[1] }), 202);
    assert.equal(await byExternal(8), undefined, 'outside the area');
    ok(await hook('workitem.deleted', { id: 7, fields: created }), 202);
    const removed = await byExternal(7);
    assert.equal(removed.status, 'removed');
    assert.equal(removed.remove_reason, 'Deleted in Azure DevOps');
  });

  test('stopping the mirror keeps the items, with their link, and makes them editable', async () => {
    const story = await byExternal(2);
    ok(await pm.del(`/api/teams/${team.id}/mirror`));
    const now = ok(await analyst.get(`/api/work-items/${story.ref}`));
    assert.equal(now.mirror, null);
    assert.ok(now.external_url.endsWith('/_workitems/edit/2'));
    ok(await analyst.patch(`/api/work-items/${story.ref}`, { title: 'Ours now' }));
  });
});
