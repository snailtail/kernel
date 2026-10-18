import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { skip, startKernel, type Client, type Harness } from './harness.js';

describe('dev platform links (#32)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, viewer: Client;
  let db: typeof import('../../src/db.js');
  let source: any, chg: string, prb: string, secret: string;

  const deliver = (event: string, body: object, opts: { secret?: string; delivery?: string; sign?: boolean } = {}) => {
    const raw = JSON.stringify(body);
    const sig = `sha256=${createHmac('sha256', opts.secret ?? secret).update(raw).digest('hex')}`;
    return fetch(`${k.base}/api/dev-hooks/${source.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': opts.delivery ?? randomUUID(), ...(opts.sign === false ? {} : { 'X-Hub-Signature-256': sig }) },
      body: raw,
    }).then(async (r) => ({ status: r.status, body: await r.json() as any }));
  };
  const repository = { full_name: 'acme/shop' };
  const pr = (number: number, title: string, extra: object = {}) => ({
    action: 'opened', repository,
    pull_request: { number, title, body: 'BODY-NOT-STORED', html_url: `https://github.com/acme/shop/pull/${number}`, state: 'open', draft: false, merged_at: null, user: { login: 'dev1' }, head: { ref: 'fix/thing' }, base: { ref: 'main' }, ...extra },
  });

  before(async () => {
    process.env.KERNEL_SECRET_KEY = 'dev-test-key-0123456789abcdefghijklmnop';
    process.env.KERNEL_DEV_STATUS_FETCH = 'false';
    k = await startKernel();
    [admin, pm, analyst, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('viewer')]);
    db = await import('../../src/db.js');
    chg = (await analyst.post('/api/changes', { title: 'Raise the connection pool' })).body.ref;
    prb = (await analyst.post('/api/problems', { title: 'Checkout times out' })).body.ref;
  });
  after(async () => {
    delete process.env.KERNEL_SECRET_KEY;
    delete process.env.KERNEL_DEV_STATUS_FETCH;
    await k?.close();
  });

  test('a GitHub source has a write-only secret, a repository allowlist and rotation', async () => {
    assert.equal((await analyst.post('/api/dev-sources', { name: 'GitHub', repositories: ['acme/shop'] })).status, 403);
    assert.equal((await pm.post('/api/dev-sources', { name: 'GitHub', repositories: [] })).status, 400, 'at least one repository');
    const r = await pm.post('/api/dev-sources', { name: 'GitHub', repositories: ['acme/shop'] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    source = r.body;
    secret = source.webhook_secret;
    assert.match(source.webhook_url, /\/api\/dev-hooks\/\d+$/);
    const listed = (await pm.get('/api/dev-sources')).body[0];
    assert.equal(listed.webhook_secret, undefined, 'the secret is never shown again');
    const stored = (await db.query('SELECT webhook_secret FROM dev_sources WHERE id = $1', [source.id])).rows[0].webhook_secret;
    assert.ok(!stored.includes(secret), 'stored encrypted');
  });

  test('deliveries are verified before anything is stored; replays and foreign repositories are refused', async () => {
    assert.equal((await deliver('pull_request', pr(1, `Fix ${chg}`), { sign: false })).status, 401);
    assert.equal((await deliver('pull_request', pr(1, `Fix ${chg}`), { secret: 'wrong' })).status, 401);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM dev_items')).rows[0].n, 0, 'nothing stored');
    assert.equal((await deliver('pull_request', { ...pr(2, `Fix ${chg}`), repository: { full_name: 'evil/fork' } })).status, 403);
    assert.equal((await deliver('ping', { zen: 'hi' })).status, 202);
    const id = randomUUID();
    const first = await deliver('pull_request', pr(3, `Fix pool size (${chg}, ${prb.replace(/(\D+)/, '$1-')})`), { delivery: id });
    assert.equal(first.status, 202);
    assert.deepEqual(first.body.linked.sort(), [chg, prb].sort(), 'refs in the title, with or without a hyphen');
    const replay = await deliver('pull_request', pr(3, `Fix pool size (${chg})`), { delivery: id });
    assert.equal(replay.body.ignored, 'replayed delivery');
    const items = (await db.query('SELECT * FROM dev_items')).rows;
    assert.ok(!JSON.stringify(items).includes('BODY-NOT-STORED'), 'PR bodies are not stored');
    const audited = (await db.query("SELECT actor_type, changes FROM audit_log WHERE action = 'dev_link'")).rows;
    assert.ok(audited.length >= 2 && audited.every((a: any) => a.actor_type === 'integration' && a.changes.delivery === id));
  });

  test('status follows GitHub: merged pull requests, checks, workflow runs and commits; the change suggests review', async () => {
    await deliver('check_suite', { repository, check_suite: { conclusion: 'success', pull_requests: [{ number: 3 }] } });
    await deliver('pull_request', { ...pr(3, `Fix pool size (${chg})`, { state: 'closed', merged_at: '2026-10-10T10:00:00Z' }), action: 'closed' });
    await deliver('workflow_run', { repository, workflow_run: { id: 99, name: 'Deploy', display_title: 'Deploy to prod', html_url: 'https://github.com/acme/shop/actions/runs/99', status: 'completed', conclusion: 'success', head_branch: 'main', pull_requests: [{ number: 3 }], actor: { login: 'dev1' } } });
    await deliver('push', { repository, ref: 'refs/heads/main', commits: [
      { id: 'a'.repeat(40), message: `Bump pool\n\nRefs ${chg}`, url: 'https://github.com/acme/shop/commit/' + 'a'.repeat(40), author: { username: 'dev1' } },
      { id: 'b'.repeat(40), message: 'Unrelated change INC0010001', url: 'https://github.com/acme/shop/commit/' + 'b'.repeat(40), author: { username: 'dev2' } },
    ] });
    const links = (await analyst.get(`/api/records/${chg}/dev-links`)).body;
    const byType = Object.fromEntries(links.map((l: any) => [l.item_type, l]));
    assert.equal(byType.pull_request.state, 'merged');
    assert.equal(byType.pull_request.checks, 'success');
    assert.equal(byType.workflow_run.state, 'success', 'the run follows the PR it built');
    assert.ok(byType.commit);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM dev_items WHERE key = $1", ['b'.repeat(40)])).rows[0].n, 0, 'a ServiceNow number is not a Kernel ref; unrelated commits are not kept');
    const c = (await analyst.get(`/api/changes/${chg}`)).body;
    assert.match(c.next_steps.steps.find((s: any) => s.id === 'implement').hint, /All 1 linked pull request is merged/);
    assert.equal(c.status, 'draft', 'a suggestion, never an automatic transition');
  });

  test('links pasted in Kernel; viewers read but cannot add; agents link and see titles as untrusted', async () => {
    assert.equal((await viewer.post(`/api/records/${prb}/dev-links`, { url: 'https://github.com/acme/shop/issues/7' })).status, 403);
    assert.equal((await analyst.post(`/api/records/${prb}/dev-links`, { url: 'https://bitbucket.org/acme/shop/pull-requests/1' })).status, 400);
    const added = (await analyst.post(`/api/records/${prb}/dev-links`, { url: 'https://github.com/acme/shop/issues/7' })).body;
    assert.ok(added.some((l: any) => l.item_type === 'issue' && l.key === '7'));
    assert.ok((await viewer.get(`/api/records/${prb}/dev-links`)).body.length >= 2);
    const mcp = new McpClient({ name: 'dev', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const res: any = await mcp.callTool({ name: 'link_dev_item', arguments: { ref: chg, url: 'https://github.com/acme/shop/pull/42' } });
    const out = JSON.parse(res.content[0].text);
    assert.ok(out.notice && out.items.every((i: any) => i.untrusted_content && i.title === undefined));
    await mcp.close();
  });

  test('a pull request that mentions a restricted change is not linked to it, and says nothing about it', async () => {
    const secretChange = (await analyst.post('/api/changes', { title: 'Rotate leaked keys' })).body.ref;
    await analyst.put(`/api/records/${secretChange}/visibility`, { restricted: true, teams: [], reason: 'Security' });
    const r = await deliver('pull_request', pr(50, `Rotate keys ${secretChange}`));
    assert.deepEqual(r.body.linked, [], 'no link, same answer as for an unknown ref');
    const unknown = await deliver('pull_request', pr(51, 'Mentions CHG999999'));
    assert.deepEqual(Object.keys(r.body).sort(), Object.keys(unknown.body).sort());
    void admin;
  });
});
