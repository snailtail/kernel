import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { skip, startKernel, type Client, type Harness } from './harness.js';

/** A self-hosted GitLab's API on loopback, behind its own CA: answers for merge request 5 of ops/kernel. */
function fakeGitLab(cert: string, key: string) {
  const seen: { path: string; token: string }[] = [];
  const server: Server = createServer({ cert, key }, (req, res) => {
    seen.push({ path: req.url ?? '', token: String(req.headers['private-token'] ?? '') });
    const json = (body: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/gitlab/api/v4/projects/ops%2Fkernel/merge_requests/5') {
      return json({ iid: 5, title: 'Raise the pool limit', state: 'merged', draft: false, author: { username: 'dev1' }, head_pipeline: { status: 'success' } });
    }
    return json({ message: '404 Not found' }, 404);
  });
  return { server, seen, listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as any).port))) };
}

describe('dev platforms: GitLab and Azure DevOps (part 1 of #32)', { skip }, () => {
  let k: Harness;
  let pm: Client, analyst: Client;
  let db: typeof import('../../src/core/db.js');
  let chg: string, prb: string;
  let gl: any, ado: any;
  let api: ReturnType<typeof fakeGitLab>;
  let ca = '';
  let port = 0;
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-'));

  const post = (sourceId: number, headers: Record<string, string>, body: object) =>
    fetch(`${k.base}/api/dev-hooks/${sourceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() as any }));
  const glHook = (event: string, body: object, opts: { token?: string; uuid?: string } = {}) =>
    post(gl.id, { 'X-Gitlab-Event': event, 'X-Gitlab-Token': opts.token ?? gl.webhook_secret, 'X-Gitlab-Event-UUID': opts.uuid ?? randomUUID() }, body);
  const basic = (password: string) => `Basic ${Buffer.from(`kernel:${password}`).toString('base64')}`;
  const adoHook = (body: object, opts: { password?: string; proto?: string } = {}) =>
    post(ado.id, { Authorization: basic(opts.password ?? ado.webhook_secret), ...(opts.proto ? { 'X-Forwarded-Proto': opts.proto } : {}) }, { id: randomUUID(), notificationId: 1, ...body });
  const project = { path_with_namespace: 'acme/shop', web_url: 'https://gitlab.com/acme/shop' };
  const mr = (iid: number, title: string, extra: object = {}) => ({
    object_kind: 'merge_request', project, user: { username: 'dev1' },
    object_attributes: { iid, title, description: 'BODY-NOT-STORED', url: `https://gitlab.com/acme/shop/-/merge_requests/${iid}`, state: 'opened', draft: false, source_branch: 'fix/pool', target_branch: 'main', ...extra },
  });
  const account = { account: { baseUrl: 'https://dev.azure.com/contoso/' } };
  const adoPr = (id: number, title: string, projectName = 'Web Shop', status = 'active') => ({
    eventType: 'git.pullrequest.updated', resourceContainers: account,
    resource: { pullRequestId: id, title, description: 'BODY-NOT-STORED', status, isDraft: false, createdBy: { displayName: 'Dev One', uniqueName: 'dev1@contoso.com' }, sourceRefName: 'refs/heads/fix/pool', targetRefName: 'refs/heads/main', repository: { name: 'shop', project: { name: projectName } } },
  });

  before(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k'), '-out', join(dir, 'c'), '-days', '1', '-subj', '/CN=gitlab', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    ca = readFileSync(join(dir, 'c'), 'utf8');
    api = fakeGitLab(ca, readFileSync(join(dir, 'k'), 'utf8'));
    port = await api.listen();
    process.env.KERNEL_SECRET_KEY = 'dev-platforms-test-key-0123456789abcdef';
    process.env.KERNEL_DEV_STATUS_FETCH = 'false';
    process.env.KERNEL_OUTBOUND_ALLOW = '127.0.0.1'; // the fake GitLab runs on loopback
    k = await startKernel();
    [pm, analyst] = await Promise.all([k.login('pm'), k.login('analyst')]);
    db = await import('../../src/core/db.js');
    chg = (await analyst.post('/api/changes', { title: 'Raise the connection pool' })).body.ref;
    prb = (await analyst.post('/api/problems', { title: 'Checkout times out' })).body.ref;
  });
  after(async () => {
    for (const v of ['KERNEL_SECRET_KEY', 'KERNEL_DEV_STATUS_FETCH', 'KERNEL_OUTBOUND_ALLOW', 'KERNEL_DEV_HOOKS_ALLOW_HTTP']) delete process.env[v];
    api?.server.close();
    rmSync(dir, { recursive: true, force: true });
    await k?.close();
  });

  test('sources per platform: the allowlist must fit the platform, only GitLab has its own address', async () => {
    assert.equal((await pm.post('/api/dev-sources', { name: 'GitLab', platform: 'gitlab', repositories: ['shop'] })).status, 400, 'group/project');
    assert.equal((await pm.post('/api/dev-sources', { name: 'ADO', platform: 'azure_devops', repositories: ['contoso/Web Shop'], base_url: 'https://ado.example.com' })).status, 400);
    assert.equal((await pm.post('/api/dev-sources', { name: 'GitLab', platform: 'gitlab', base_url: 'http://git.example.com', repositories: ['a/b'] })).status, 400, 'https only');
    assert.equal((await pm.post('/api/dev-sources', { name: 'GitLab', platform: 'gitlab', repositories: ['a/b'], private_allow: ['127.0.0.1'] })).status, 400, 'loopback is never a private range');
    const r = await pm.post('/api/dev-sources', { name: 'GitLab', platform: 'gitlab', repositories: ['acme/shop'] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    gl = r.body;
    assert.ok(gl.events.includes('Merge request events'));
    ado = (await pm.post('/api/dev-sources', { name: 'Azure DevOps', platform: 'azure_devops', repositories: ['contoso/Web Shop'] })).body;
    const listed = (await pm.get('/api/dev-sources')).body;
    assert.deepEqual(listed.map((s: any) => [s.platform, s.base_url]).sort(), [['azure_devops', 'https://dev.azure.com'], ['gitlab', 'https://gitlab.com']]);
    assert.ok(listed.every((s: any) => s.webhook_secret === undefined));
  });

  test('GitLab: the token is checked, replays and other projects are refused, a merge request links what it mentions', async () => {
    assert.equal((await glHook('Merge Request Hook', mr(1, `Fix ${chg}`), { token: 'wrong' })).status, 401);
    assert.equal((await post(gl.id, { 'X-Gitlab-Event': 'Merge Request Hook', 'X-Gitlab-Event-UUID': randomUUID() }, mr(1, `Fix ${chg}`))).status, 401, 'no token');
    assert.equal((await post(gl.id, { 'X-Gitlab-Event': 'Merge Request Hook', 'X-Gitlab-Token': gl.webhook_secret }, mr(1, `Fix ${chg}`))).status, 400, 'no delivery id');
    assert.equal((await glHook('Merge Request Hook', { ...mr(2, `Fix ${chg}`), project: { path_with_namespace: 'evil/fork' } })).status, 403);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM dev_items WHERE platform = 'gitlab'")).rows[0].n, 0, 'nothing stored');
    const uuid = randomUUID();
    const first = await glHook('Merge Request Hook', mr(3, `Fix pool size (${chg})`), { uuid });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.deepEqual(first.body.linked, [chg]);
    assert.equal((await glHook('Merge Request Hook', mr(3, `Fix pool size (${chg})`), { uuid })).body.ignored, 'replayed delivery');
    assert.equal((await glHook('Confidential Issue Hook', { object_kind: 'issue', project, object_attributes: { iid: 9, title: `Leak ${prb}`, confidential: true } })).body.ignored, 'event not handled');

    await glHook('Pipeline Hook', { object_kind: 'pipeline', project, user: { username: 'ci' }, merge_request: { iid: 3 }, object_attributes: { id: 77, status: 'failed', ref: 'fix/pool', sha: 'f'.repeat(40) } });
    await glHook('Merge Request Hook', mr(3, `Fix pool size (${chg})`, { state: 'merged' }));
    await glHook('Push Hook', { object_kind: 'push', project, ref: 'refs/heads/main', commits: [{ id: 'c'.repeat(40), message: `Bump pool\n\nRefs ${prb}`, url: 'javascript:alert(1)', author: { name: 'Dev One', email: 'dev1@example.com' } }] });
    const links = (await analyst.get(`/api/records/${chg}/dev-links`)).body;
    const byType = Object.fromEntries(links.map((l: any) => [l.item_type, l]));
    assert.equal(byType.pull_request.platform, 'gitlab');
    assert.equal(byType.pull_request.state, 'merged');
    assert.equal(byType.pull_request.checks, 'failure', 'a merge request pipeline is its checks');
    assert.equal(byType.workflow_run.state, 'failure', 'the pipeline follows the merge request it ran for');
    const commit = (await analyst.get(`/api/records/${prb}/dev-links`)).body.find((l: any) => l.item_type === 'commit');
    assert.equal(commit.url, '', 'a URL that is not https is not kept');
    assert.equal(commit.author, 'Dev One', 'the name, not the address');
    const items = JSON.stringify((await db.query('SELECT * FROM dev_items')).rows);
    assert.ok(!items.includes('BODY-NOT-STORED') && !items.includes('dev1@example.com'));
    assert.ok((await db.query("SELECT 1 FROM change_activity WHERE body LIKE '%(mentioned on GitLab)'")).rowCount, 'the activity names the platform');
  });

  test('Azure DevOps: HTTPS only, the Basic password is checked, replays and other projects are refused', async () => {
    const pr = adoPr(42, `Raise the pool (${chg})`);
    assert.equal((await adoHook(pr)).status, 403, 'plain HTTP: the secret would travel in clear');
    process.env.KERNEL_DEV_HOOKS_ALLOW_HTTP = 'true';
    assert.equal((await adoHook(pr, { password: 'wrong' })).status, 401);
    assert.equal((await post(ado.id, {}, { id: randomUUID(), notificationId: 1, ...pr })).status, 401, 'no credentials');
    assert.equal((await post(ado.id, { Authorization: basic(ado.webhook_secret) }, pr)).status, 400, 'no notification id');
    assert.equal((await adoHook(adoPr(43, `Fix ${chg}`, 'Other'))).status, 403);
    const event = { id: randomUUID(), notificationId: 7 };
    const first = await adoHook({ ...pr, ...event });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.deepEqual(first.body.linked, [chg]);
    assert.equal((await adoHook({ ...pr, ...event })).body.ignored, 'replayed delivery');

    await adoHook({ eventType: 'build.complete', resourceContainers: account, resource: { id: 900, buildNumber: '20261018.1', status: 'completed', result: 'succeeded', sourceBranch: 'refs/pull/42/merge', definition: { name: 'CI', project: { name: 'Web Shop' } }, requestedFor: { displayName: 'Dev One' } } });
    await adoHook(adoPr(42, `Raise the pool (${chg})`, 'Web Shop', 'completed'));
    await adoHook({ eventType: 'workitem.updated', resourceContainers: account, resource: { workItemId: 77, revision: { fields: { 'System.TeamProject': 'web shop', 'System.Title': `Pool exhausted, see ${prb}`, 'System.State': 'Active', 'System.CreatedBy': 'Dev One <dev1@contoso.com>' } } } });
    const links = (await analyst.get(`/api/records/${chg}/dev-links`)).body.filter((l: any) => l.platform === 'azure_devops');
    const byType = Object.fromEntries(links.map((l: any) => [l.item_type, l]));
    assert.equal(byType.pull_request.state, 'merged');
    assert.equal(byType.pull_request.checks, 'success', 'the PR validation build is its checks');
    assert.equal(byType.pull_request.url, 'https://dev.azure.com/contoso/Web%20Shop/_git/shop/pullrequest/42');
    assert.equal(byType.workflow_run.state, 'success');
    const wi = (await analyst.get(`/api/records/${prb}/dev-links`)).body.find((l: any) => l.platform === 'azure_devops');
    assert.deepEqual([wi.item_type, wi.state, wi.author], ['issue', 'active', 'Dev One']);
    delete process.env.KERNEL_DEV_HOOKS_ALLOW_HTTP;
  });

  test('pasted links from GitLab and Azure DevOps; a self-hosted GitLab answers through its CA with the source token', async () => {
    assert.equal((await analyst.post(`/api/records/${prb}/dev-links`, { url: 'https://dev.azure.com/contoso/Web%20Shop/_workitems/edit/12' })).status, 200);
    assert.equal((await analyst.post(`/api/records/${prb}/dev-links`, { url: `https://127.0.0.1:${port}/gitlab/ops/kernel/-/merge_requests/5` })).status, 400, 'an unconfigured host is not GitLab');
    const self = await pm.post('/api/dev-sources', { name: 'Internal GitLab', platform: 'gitlab', base_url: `https://127.0.0.1:${port}/gitlab/`, repositories: ['ops/kernel'], api_token: 'glpat-read', ca_pem: ca });
    assert.equal(self.status, 201, JSON.stringify(self.body));
    delete process.env.KERNEL_DEV_STATUS_FETCH;
    try {
      const added = await analyst.post(`/api/records/${prb}/dev-links`, { url: `https://127.0.0.1:${port}/gitlab/ops/kernel/-/merge_requests/5` });
      assert.equal(added.status, 200, JSON.stringify(added.body));
      const item = added.body.find((l: any) => l.repo === 'ops/kernel');
      assert.deepEqual([item.title, item.state, item.checks, item.author], ['Raise the pool limit', 'merged', 'success', 'dev1']);
      assert.deepEqual(api.seen.at(-1), { path: '/gitlab/api/v4/projects/ops%2Fkernel/merge_requests/5', token: 'glpat-read' });
    } finally {
      process.env.KERNEL_DEV_STATUS_FETCH = 'false';
    }
    const stored = (await db.query('SELECT api_token FROM dev_sources WHERE id = $1', [self.body.id])).rows[0].api_token;
    assert.ok(!stored.includes('glpat-read'), 'the token is stored encrypted');
  });
});
