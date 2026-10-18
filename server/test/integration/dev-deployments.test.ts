import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { skip, startKernel, type Client, type Harness } from './harness.js';

/** A self-hosted GitLab that records the commit statuses Kernel posts. */
function fakeGitLab(cert: string, key: string) {
  const posted: { path: string; token: string; body: any }[] = [];
  const server: Server = createServer({ cert, key }, (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'POST') posted.push({ path: req.url ?? '', token: String(req.headers['private-token'] ?? ''), body: JSON.parse(raw || '{}') });
      res.writeHead(req.method === 'POST' ? 201 : 404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return { server, posted, listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as any).port))) };
}

describe('dev platforms: deployments, standard changes and status on pull requests (part 2 of #32)', { skip }, () => {
  let k: Harness;
  let pm: Client, analyst: Client;
  let db: typeof import('../../src/db.js');
  let gh: any, gl: any, app: string, svc: string, template: any, chg: string;
  let api: ReturnType<typeof fakeGitLab>;
  let ca = '';
  let port = 0;
  const dir = mkdtempSync(join(tmpdir(), 'deploy-'));
  const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

  const deliver = (event: string, body: object) => {
    const raw = JSON.stringify({ repository: { full_name: 'acme/shop' }, ...body });
    return fetch(`${k.base}/api/dev-hooks/${gh.id}`, {
      method: 'POST', body: raw,
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': randomUUID(), 'X-Hub-Signature-256': `sha256=${createHmac('sha256', gh.webhook_secret).update(raw).digest('hex')}` },
    }).then(async (r) => ({ status: r.status, body: await r.json() as any }));
  };
  const pr = (number: number, title: string, extra: object = {}) => deliver('pull_request', {
    action: 'closed', pull_request: { number, title, body: '', html_url: `https://github.com/acme/shop/pull/${number}`, state: 'closed', draft: false, merged_at: at(-1), merge_commit_sha: 'm'.repeat(40), user: { login: 'dev1' }, head: { ref: 'fix', sha: 'h'.repeat(40) }, base: { ref: 'main' }, ...extra },
  });
  const deploy = (id: number, environment: string, state: string, extra: { task?: string; description?: string; sha?: string; created_at?: string } = {}) => deliver('deployment_status', {
    deployment: { id, environment, sha: extra.sha ?? 'm'.repeat(40), ref: 'main', task: extra.task ?? 'deploy', description: extra.description ?? '', creator: { login: 'ci' }, created_at: extra.created_at ?? at(-0.2) },
    deployment_status: { state, environment, target_url: `https://github.com/acme/shop/actions/runs/${id}`, created_at: extra.created_at ?? at(-0.1) },
  });
  const changesFrom = async (key: string) => (await db.query('SELECT ref, status, outcome, change_type, actual_start FROM changes WHERE source_key = $1', [key])).rows;
  const implement = async (ref: string) => (await analyst.get(`/api/changes/${ref}`)).body.next_steps.steps.find((s: any) => s.id === 'implement');

  before(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k'), '-out', join(dir, 'c'), '-days', '1', '-subj', '/CN=gitlab', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    ca = readFileSync(join(dir, 'c'), 'utf8');
    api = fakeGitLab(ca, readFileSync(join(dir, 'k'), 'utf8'));
    port = await api.listen();
    process.env.KERNEL_SECRET_KEY = 'dev-deployments-test-key-0123456789abcdef';
    process.env.KERNEL_DEV_STATUS_FETCH = 'false';
    process.env.KERNEL_OUTBOUND_ALLOW = '127.0.0.1';
    k = await startKernel();
    [pm, analyst] = await Promise.all([k.login('pm'), k.login('analyst')]);
    db = await import('../../src/db.js');
    app = (await pm.post('/api/cis', { name: 'shop-web', ci_type: 'application', criticality: 4 })).body.ref;
    svc = (await pm.post('/api/cis', { name: 'shop-api', ci_type: 'application', criticality: 4 })).body.ref;
    template = (await pm.post('/api/change-templates', { name: 'Deploy the shop', max_risk: 'high', ci_types: ['application'], implementation_plan: 'Run the pipeline', backout_plan: 'Redeploy the previous version' })).body;
    gh = (await pm.post('/api/dev-sources', { name: 'GitHub', repositories: ['acme/shop', 'acme/admin'] })).body;
    chg = (await analyst.post('/api/changes', { title: 'Raise the connection pool' })).body.ref;
  });
  after(async () => {
    for (const v of ['KERNEL_SECRET_KEY', 'KERNEL_DEV_STATUS_FETCH', 'KERNEL_OUTBOUND_ALLOW']) delete process.env[v];
    api?.server.close();
    rmSync(dir, { recursive: true, force: true });
    await k?.close();
  });

  test('deployment targets map a repository and environment to CIs; registering changes is explicit', async () => {
    const add = (as: Client, body: object) => as.post(`/api/dev-sources/${gh.id}/targets`, { repo: 'acme/shop', environment: 'production', cis: [app], production: true, ...body });
    assert.equal((await add(analyst, {})).status, 403);
    assert.equal((await add(pm, { repo: 'evil/fork' })).status, 400, 'only the source’s repositories');
    assert.equal((await add(pm, { cis: ['CI999999'] })).status, 400, 'unknown CI');
    assert.equal((await add(pm, { register_change: true })).status, 400, 'a template is needed');
    assert.equal((await add(pm, { register_change: true, template_id: template.id, production: false })).status, 400, 'only production registers changes');
    const t = await add(pm, { register_change: true, template_id: template.id });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    assert.deepEqual([t.body.cis, t.body.template_name], [[app], 'Deploy the shop']);
    assert.equal((await add(pm, { environment: 'PRODUCTION' })).status, 409, 'one mapping per repository and environment');
    assert.equal((await pm.post(`/api/dev-sources/${gh.id}/targets`, { repo: 'acme/admin', environment: 'production', cis: [svc], production: true })).status, 201, 'production, but no change registration');
    assert.equal((await pm.get(`/api/dev-sources/${gh.id}/targets`)).body.length, 2);
  });

  test('a successful production deploy registers one standard change with its PRs and CIs; staging and unmapped do not', async () => {
    await pr(3, `Fix pool size (${chg})`);
    const staging = await deploy(100, 'staging', 'success');
    assert.deepEqual(staging.body.linked, [chg], 'the deploy follows the PR it contains');
    assert.equal((await changesFrom('github:acme/shop:100')).length, 0, 'staging registers nothing');
    // Merged months ago and only edited now: not part of this deploy (contents go by merged_at, not the last update).
    await pr(4, `Old cleanup (${chg})`, { merged_at: '2026-01-02T10:00:00Z', merge_commit_sha: 'o'.repeat(40), head: { ref: 'old', sha: 'p'.repeat(40) } });
    assert.equal((await deploy(101, 'production', 'in_progress')).status, 202);
    assert.equal((await changesFrom('github:acme/shop:101')).length, 0, 'not until it succeeded');
    await deploy(101, 'production', 'success');
    await deploy(101, 'production', 'success'); // the same deploy delivered again
    const registered = await changesFrom('github:acme/shop:101');
    assert.equal(registered.length, 1, 'one change per deployment');
    const c = (await analyst.get(`/api/changes/${registered[0].ref}`)).body;
    assert.deepEqual([c.change_type, c.status, c.outcome, c.source], ['standard', 'closed', 'successful', 'pipeline']);
    assert.deepEqual(c.affected_cis.map((x: any) => x.ref), [app]);
    assert.ok(c.actual_start && c.actual_end, 'times from the deploy feed change-incident correlation');
    const links = (await analyst.get(`/api/records/${c.ref}/dev-links`)).body;
    assert.deepEqual(links.map((l: any) => [l.item_type, l.key]).sort(), [['deployment', '101'], ['pull_request', '3']]);
    const created = (await db.query("SELECT a.data FROM change_activity a JOIN changes c ON c.id = a.change_id WHERE c.ref = $1 AND a.kind = 'created'", [c.ref])).rows[0].data;
    const pmId = (await db.query("SELECT id FROM users WHERE username = 'pm'")).rows[0].id;
    assert.deepEqual([created.authorised_by, typeof created.deploy_target], [pmId, 'number'], 'the history names who allowed registration, and the target');
    assert.equal(links.find((l: any) => l.item_type === 'deployment').environment, 'production');

    await deliver('deployment_status', { repository: { full_name: 'acme/admin' }, deployment: { id: 200, environment: 'production', sha: 'a'.repeat(40), ref: 'main' }, deployment_status: { state: 'success', environment: 'production' } });
    assert.equal((await changesFrom('github:acme/admin:200')).length, 0, 'the mapping did not turn registration on');
  });

  test('outcomes are suggested from deployments, never decided', async () => {
    let step = await implement(chg);
    assert.deepEqual(step.suggestion, { outcome: 'successful', to: 'review', reason: 'All 2 linked pull requests are merged and deployed to production' });
    await deploy(102, 'production', 'failure');
    step = await implement(chg);
    assert.equal(step.suggestion.outcome, 'failed');
    assert.match(step.hint, /deployment to production failed/);
    await deploy(103, 'production', 'success', { task: 'rollback', description: 'Roll back 4.2' });
    step = await implement(chg);
    assert.equal(step.suggestion.outcome, 'rolled_back');
    const c = (await analyst.get(`/api/changes/${chg}`)).body;
    assert.deepEqual([c.status, c.outcome], ['draft', null], 'nothing transitioned by itself');
  });

  test('a deploy outside the template’s scope registers nothing and says why', async () => {
    await pm.post('/api/change-freezes', { name: 'Peak season', starts_at: '2031-01-01T00:00:00Z', ends_at: '2031-01-02T00:00:00Z', reason: 'Sales' });
    await deploy(104, 'production', 'success', { created_at: '2031-01-01T10:00:00Z' });
    assert.equal((await changesFrom('github:acme/shop:104')).length, 0);
    const item = (await db.query("SELECT data FROM dev_items WHERE item_type = 'deployment' AND key = '104'")).rows[0];
    assert.match(item.data.change_error, /Peak season/);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'deploy_change_refused'")).rows[0].n, 1);
  });

  test('the change status goes back on the pull request with its own write-only token, only when opted in', async () => {
    const base = `https://127.0.0.1:${port}/gitlab`;
    assert.equal((await pm.post('/api/dev-sources', { name: 'No token', platform: 'gitlab', base_url: base, repositories: ['ops/other'], post_status: true })).body.id > 0, true);
    assert.equal((await pm.get('/api/dev-sources')).body.find((s: any) => s.name === 'No token').post_status, false, 'posting needs the status token');
    gl = (await pm.post('/api/dev-sources', { name: 'Internal GitLab', platform: 'gitlab', base_url: base, repositories: ['ops/kernel'], api_token: 'glpat-read', status_token: 'glpat-status', post_status: true, ca_pem: ca })).body;
    const listed = (await pm.get('/api/dev-sources')).body.find((s: any) => s.id === gl.id);
    assert.deepEqual([listed.has_status_token, listed.post_status, listed.status_token], [true, true, undefined]);
    assert.ok(!(await db.query('SELECT status_token FROM dev_sources WHERE id = $1', [gl.id])).rows[0].status_token.includes('glpat-status'), 'stored encrypted');

    const std = (await analyst.post('/api/changes', { title: 'Ship the pool fix', template_id: template.id, cis: [app], planned_start: at(-1), planned_end: at(1) })).body.ref;
    const mr = await fetch(`${k.base}/api/dev-hooks/${gl.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gitlab-Event': 'Merge Request Hook', 'X-Gitlab-Token': gl.webhook_secret, 'X-Gitlab-Event-UUID': randomUUID() },
      body: JSON.stringify({ object_kind: 'merge_request', project: { path_with_namespace: 'ops/kernel', web_url: `${base}/ops/kernel` }, user: { username: 'dev1' },
        object_attributes: { iid: 5, title: `Pool fix ${std}`, url: `${base}/ops/kernel/-/merge_requests/5`, state: 'opened', source_branch: 'fix', target_branch: 'main', last_commit: { id: 'e'.repeat(40) } } }),
    });
    assert.equal(mr.status, 202);
    assert.equal(api.posted.length, 1);
    assert.deepEqual(api.posted[0], {
      path: `/gitlab/api/v4/projects/ops%2Fkernel/statuses/${'e'.repeat(40)}`, token: 'glpat-status',
      body: { state: 'pending', name: 'kernel/change', description: `${std} not yet authorised`, target_url: `/changes/${std}` },
    });
    await analyst.post(`/api/changes/${std}/transition`, { to: 'scheduled' });
    assert.equal(api.posted.length, 2, 'posted again when the change moved');
    assert.equal(api.posted[1].body.state, 'success');
    assert.match(api.posted[1].body.description, new RegExp(`^${std} authorised, window \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d`));
    const ghPr = (await db.query("SELECT data FROM dev_items WHERE platform = 'github' AND item_type = 'pull_request'")).rows[0];
    assert.equal(ghPr.data.kernel_status, undefined, 'a source that did not opt in posts nothing');
  });
});
