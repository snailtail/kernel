import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: any }, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};

type Issue = Record<string, any>;

/**
 * GitHub's and GitLab's issue APIs on loopback, behind one CA: the list (label filter, pages), one issue (404 when
 * deleted) and a comment, which is recorded.
 */
function fakeGitPlatforms(cert: string, key: string) {
  const github = new Map<number, Issue>();
  const gitlab = new Map<number, Issue>();
  const comments: { path: string; body: string; auth: string }[] = [];
  const auths: string[] = [];
  const server: Server = createServer({ cert, key }, (req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (body: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const url = new URL(req.url ?? '', 'https://fake');
      const auth = String(req.headers.authorization ?? req.headers['private-token'] ?? '');
      auths.push(auth);
      const page = (all: Issue[]) => {
        const label = url.searchParams.get('labels');
        const per = Number(url.searchParams.get('per_page') ?? 100);
        const n = Number(url.searchParams.get('page') ?? 1);
        const named = (i: Issue) => (i.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name ?? l.title));
        return all.filter((i) => !label || named(i).includes(label)).slice((n - 1) * per, n * per);
      };
      let m = url.pathname.match(/^\/api\/v3\/repos\/acme\/shop\/issues(?:\/(\d+))?(\/comments)?$/);
      if (m) {
        if (!m[1]) return json(page([...github.values()]));
        const issue = github.get(Number(m[1]));
        if (!issue) return json({ message: 'Not Found' }, 404);
        if (m[2] && req.method === 'POST') {
          comments.push({ path: url.pathname, body: JSON.parse(raw).body, auth });
          return json({ id: comments.length }, 201);
        }
        return json(issue);
      }
      m = url.pathname.match(/^\/api\/v4\/projects\/acme%2Fplatform\/issues(?:\/(\d+))?(\/notes)?$/);
      if (m) {
        if (!m[1]) return json(page([...gitlab.values()]));
        const issue = gitlab.get(Number(m[1]));
        if (!issue) return json({ message: '404 Not found' }, 404);
        if (m[2] && req.method === 'POST') {
          comments.push({ path: url.pathname, body: JSON.parse(raw).body, auth });
          return json({ id: comments.length }, 201);
        }
        return json(issue);
      }
      return json({ message: 'Not found' }, 404);
    });
  });
  return { server, github, gitlab, comments, auths, listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as any).port))) };
}

const ghIssue = (number: number, title: string, labels: string[], extra: Issue = {}): [number, Issue] => [number, {
  number, title, labels: labels.map((name) => ({ name })), state: 'open', state_reason: null, milestone: null, html_url: `https://github.com/acme/shop/issues/${number}`,
  body: 'BODY-NOT-COPIED', ...extra,
}];
const glIssue = (iid: number, title: string, labels: string[], extra: Issue = {}): [number, Issue] => [iid, {
  iid, title, labels, state: 'opened', issue_type: 'issue', weight: null, milestone: null, iteration: null, confidential: false,
  web_url: `https://gitlab.example/acme/platform/-/issues/${iid}`, description: 'BODY-NOT-COPIED', ...extra,
}];

describe('mirrored backlogs from GitHub and GitLab (part 2 of #168)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;
  let shop: { id: number }, platform: { id: number };
  let gh: any, gl: any;
  let fake: ReturnType<typeof fakeGitPlatforms>;
  let prb: string;
  let sendSourceComments: () => Promise<number>;
  const dir = mkdtempSync(join(tmpdir(), 'git-'));
  const byExternal = async (source: string, id: string) => {
    const { rows } = await ownerQuery('SELECT ref FROM work_items WHERE source = $1 AND external_id = $2', [source, id]);
    return rows[0] ? ok(await analyst.get(`/api/work-items/${rows[0].ref}`)) : undefined;
  };
  const shopItem = (n: number) => byExternal('github', `acme/shop#${n}`);
  const platformItem = (n: number) => byExternal('gitlab', `acme/platform#${n}`);
  const sync = async (team: { id: number }) => ok(await pm.post(`/api/teams/${team.id}/mirror/sync`, {}));
  const githubHook = (action: string, issue: Issue, opts: { secret?: string; id?: string } = {}) => {
    const raw = JSON.stringify({ action, issue, repository: { full_name: 'acme/shop' } });
    const signature = `sha256=${createHmac('sha256', opts.secret ?? gh.webhook_secret).update(raw).digest('hex')}`;
    return fetch(`${k.base}/api/dev-hooks/${gh.id}`, {
      method: 'POST', body: raw,
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': opts.id ?? randomUUID(), 'X-Hub-Signature-256': signature },
    }).then(async (r) => ({ status: r.status, body: await r.json() as any }));
  };
  const gitlabHook = (attributes: Issue, labels: string[], opts: { token?: string } = {}) =>
    fetch(`${k.base}/api/dev-hooks/${gl.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gitlab-Event': 'Issue Hook', 'X-Gitlab-Event-UUID': randomUUID(), 'X-Gitlab-Token': opts.token ?? gl.webhook_secret },
      // A delivery names the milestone and iteration only by id.
      body: JSON.stringify({ object_kind: 'issue', project: { path_with_namespace: 'acme/platform' }, labels: labels.map((title) => ({ title })), object_attributes: { ...attributes, url: attributes.web_url, milestone_id: 7 } }),
    }).then(async (r) => ({ status: r.status, body: await r.json() as any }));

  before(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k'), '-out', join(dir, 'c'), '-days', '1', '-subj', '/CN=git', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    const ca = readFileSync(join(dir, 'c'), 'utf8');
    fake = fakeGitPlatforms(ca, readFileSync(join(dir, 'k'), 'utf8'));
    const port = await fake.listen();
    process.env.KERNEL_SECRET_KEY = 'work-item-mirror-git-test-key-0123456789abcdef';
    process.env.KERNEL_DEV_STATUS_FETCH = 'false';
    process.env.KERNEL_OUTBOUND_ALLOW = '127.0.0.1';
    k = await startKernel();
    ({ sendSourceComments } = await import('../../src/development/mirror.js'));
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
    ok(await admin.put('/api/admin/modules', { development: true, reason: 'Teams plan in GitHub and GitLab' }));
    shop = ok(await admin.post('/api/teams', { name: 'Shop' }), 201);
    platform = ok(await admin.post('/api/teams', { name: 'Platform' }), 201);
    gh = ok(await pm.post('/api/dev-sources', { name: 'GitHub', platform: 'github', repositories: ['acme/shop'], api_token: 'gh-token' }), 201);
    gl = ok(await pm.post('/api/dev-sources', { name: 'GitLab', platform: 'gitlab', base_url: 'https://gitlab.example', repositories: ['acme/platform'], api_token: 'gl-token' }), 201);
    // Both APIs are the fake one, reached through the source's own CA.
    for (const s of [gh, gl]) await ownerQuery('UPDATE dev_sources SET base_url = $2, ca_pem = $3 WHERE id = $1', [s.id, `https://127.0.0.1:${port}`, ca]);
    prb = ok(await analyst.post('/api/problems', { title: 'Checkout times out' }), 201).ref;
    const today = new Date().toISOString().slice(0, 10);
    const later = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
    for (const t of [shop, platform]) ok(await analyst.post('/api/sprints', { team_id: t.id, name: 'Sprint 1', starts_on: today, ends_on: later }), 201);
    for (const [n, i] of [
      ghIssue(1, 'Faster checkout', ['team-shop', 'epic']),
      ghIssue(2, 'Pay with one click', ['team-shop', 'enhancement'], { milestone: { title: 'Sprint 1' } }),
      ghIssue(3, 'Pool exhausted at checkout', ['team-shop', 'bug'], { state: 'closed', state_reason: 'completed' }),
      ghIssue(4, 'Raise the pool limit', ['team-shop'], { type: { name: 'Task' }, state: 'closed', state_reason: 'not_planned' }),
      ghIssue(5, 'Another team\'s issue', ['team-search']),
      ghIssue(6, 'A pull request, not a work item', ['team-shop'], { pull_request: { url: 'x' } }),
    ]) fake.github.set(n, i);
    for (const [n, i] of [
      glIssue(1, 'Disk fills on the build hosts', ['bug', 'workflow::Doing'], { weight: 3, iteration: { title: 'Sprint 1' } }),
      glIssue(2, 'Rotate the runner tokens', [], { issue_type: 'task', state: 'closed' }),
      glIssue(3, 'A confidential security issue', ['bug'], { confidential: true }),
    ]) fake.gitlab.set(n, i);
  });
  after(async () => {
    for (const v of ['KERNEL_SECRET_KEY', 'KERNEL_DEV_STATUS_FETCH', 'KERNEL_OUTBOUND_ALLOW']) delete process.env[v];
    fake?.server.close();
    rmSync(dir, { recursive: true, force: true });
    await k?.close();
  });

  test('settings: a GitHub repository with a label, a GitLab project; each platform says what its area is', async () => {
    const native = ok(await pm.get(`/api/teams/${shop.id}/mirror`));
    assert.equal(native.mirrored, false);
    assert.equal(native.may_manage, true);
    assert.deepEqual([native.platforms.github.area_name, native.platforms.azure_devops.area_name], ['label', 'area path']);
    assert.deepEqual(native.sources.map((x: any) => [x.name, x.has_token]), [['GitHub', true], ['GitLab', true]], 'the sources to choose from, without secrets');
    assert.equal(native.sources[0].api_token, undefined);
    // Dev sources are administered under changes; a manager sets up a mirror with the change module off too.
    ok(await admin.put('/api/admin/modules', { change: false, reason: 'Only development here' }));
    assert.equal(ok(await pm.get(`/api/teams/${shop.id}/mirror`)).sources.length, 2);
    ok(await admin.put('/api/admin/modules', { change: true, reason: 'Back on' }));
    const viewer = ok(await analyst.get(`/api/teams/${shop.id}/mirror`));
    assert.equal(viewer.may_manage, false);
    assert.deepEqual(viewer.sources, [], 'only managers see the sources');
    assert.equal((await pm.put(`/api/teams/${shop.id}/mirror`, { source_id: gh.id, scope: 'acme/other' })).status, 400);
    const m = ok(await pm.put(`/api/teams/${shop.id}/mirror`, { source_id: gh.id, scope: 'acme/shop', area: 'team-shop' }));
    assert.equal(m.source_label, 'GitHub');
    assert.equal(m.comment_links, true, 'link comments are on by default');
    ok(await pm.put(`/api/teams/${platform.id}/mirror`, { source_id: gl.id, scope: 'acme/platform' }));
  });

  test('GitHub: the type from the issue type or a label, the state with its reason, the milestone as sprint; pull requests are not items', async () => {
    const run = await sync(shop);
    assert.equal(run.status, 'succeeded', run.message);
    assert.deepEqual(run.counts, { created: 4, updated: 0, unchanged: 0, skipped: 0, removed: 0 });
    assert.ok(fake.auths.includes('Bearer gh-token'), 'with the source token');
    const [epic, story, bug, task] = [await shopItem(1), await shopItem(2), await shopItem(3), await shopItem(4)];
    assert.equal(await shopItem(5), undefined, 'without the team\'s label');
    assert.equal(await shopItem(6), undefined, 'a pull request');
    assert.deepEqual([epic.item_type, story.item_type, bug.item_type, task.item_type], ['epic', 'story', 'bug', 'task']);
    assert.deepEqual([epic.status, story.status, bug.status, task.status], ['new', 'new', 'done', 'removed']);
    assert.equal(task.remove_reason, 'Removed in GitHub', 'closed as not planned');
    assert.equal(story.sprint?.name, 'Sprint 1', 'the milestone names the team\'s sprint');
    assert.equal(story.description, '', 'the body stays in GitHub');
    assert.equal(story.mirror.url, 'https://github.com/acme/shop/issues/2');
    assert.equal(story.mirror.label, 'GitHub');
    assert.deepEqual((await sync(shop)).counts, { created: 0, updated: 0, unchanged: 4, skipped: 0, removed: 0 }, 'idempotent');

    // An adjusted mapping: this team counts an open issue as ready.
    ok(await pm.put(`/api/teams/${shop.id}/mirror`, { source_id: gh.id, scope: 'acme/shop', area: 'team-shop', status_map: { Open: 'ready' } }));
    await sync(shop);
    assert.deepEqual([(await shopItem(1)).status, (await shopItem(2)).status], ['ready', 'ready']);
    ok(await pm.put(`/api/teams/${shop.id}/mirror`, { source_id: gh.id, scope: 'acme/shop', area: 'team-shop' }));
    await sync(shop);
    assert.equal((await shopItem(2)).status, 'new');
  });

  test('GitLab: a workflow label as the state, the weight as points, the iteration as sprint; confidential issues stay out', async () => {
    const run = await sync(platform);
    assert.equal(run.status, 'succeeded', run.message);
    assert.deepEqual(run.counts, { created: 2, updated: 0, unchanged: 0, skipped: 0, removed: 0 });
    assert.ok(fake.auths.includes('gl-token'), 'with the source token');
    const [bug, task] = [await platformItem(1), await platformItem(2)];
    assert.equal(await platformItem(3), undefined, 'confidential');
    assert.deepEqual([bug.item_type, bug.status, bug.points, bug.sprint?.name], ['bug', 'in_progress', 3, 'Sprint 1']);
    assert.deepEqual([task.item_type, task.status], ['task', 'done']);
    assert.equal(bug.mirror.label, 'GitLab');
    assert.deepEqual((await sync(platform)).counts.unchanged, 2, 'idempotent');
  });

  test('the fields the source owns are read-only; Kernel\'s links work on mirrored items (#167)', async () => {
    const story = await shopItem(2);
    const refused = await analyst.patch(`/api/work-items/${story.ref}`, { title: 'Renamed here' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /mirrored from GitHub, which owns its title/);
    assert.equal((await analyst.post(`/api/work-items/${(await platformItem(1)).ref}/transition`, { to: 'done' })).status, 409);
    ok(await analyst.post(`/api/work-items/${story.ref}/links`, { kind: 'problem', reference: prb }));
    assert.ok((await shopItem(2)).links.some((l: any) => l.reference === prb));
    const trace = ok(await analyst.get(`/api/records/${prb}/trace`));
    assert.ok(trace.nodes.some((n: any) => n.ref === story.ref), 'the problem traces to the mirrored story');
  });

  test('a link to a Kernel record is noted in the source once; never a restricted record, never when turned off', async () => {
    const story = await shopItem(2);
    assert.equal(await sendSourceComments(), 1);
    assert.deepEqual(fake.comments.at(-1), { path: '/api/v3/repos/acme/shop/issues/2/comments', body: `Linked to ${prb} in Kernel`, auth: 'Bearer gh-token' });
    // Unlinked and linked again: already said.
    const link = (await shopItem(2)).links.find((l: any) => l.reference === prb);
    ok(await analyst.del(`/api/work-items/${story.ref}/links/${link.id}`));
    ok(await analyst.post(`/api/work-items/${story.ref}/links`, { kind: 'problem', reference: prb }));
    assert.equal(await sendSourceComments(), 0);

    const hidden = ok(await analyst.post('/api/problems', { title: 'A security problem' }), 201).ref;
    ok(await analyst.put(`/api/records/${hidden}/visibility`, { restricted: true, reason: 'Security investigation' }));
    ok(await analyst.post(`/api/work-items/${story.ref}/links`, { kind: 'problem', reference: hidden }));
    assert.equal(await sendSourceComments(), 0, 'a restricted record is not announced');

    // Restricted after the comment was queued (a retry can wait two hours): checked again when it is sent.
    const later = ok(await analyst.post('/api/problems', { title: 'Card numbers in the logs' }), 201).ref;
    ok(await analyst.post(`/api/work-items/${story.ref}/links`, { kind: 'problem', reference: later }));
    assert.equal((await ownerQuery('SELECT status FROM work_item_source_comments WHERE reference = $1', [later])).rows[0]?.status, 'pending');
    ok(await analyst.put(`/api/records/${later}/visibility`, { restricted: true, reason: 'Security investigation' }));
    const before = fake.comments.length;
    assert.equal(await sendSourceComments(), 0, 'restricted before it was sent');
    assert.equal(fake.comments.length, before);
    assert.equal((await ownerQuery('SELECT status FROM work_item_source_comments WHERE reference = $1', [later])).rows[0].status, 'skipped');

    const inc = ok(await analyst.post('/api/incidents', { title: 'Runners stall', impact: 3, urgency: 3 }), 201).ref;
    const runnerTask = await platformItem(2);
    ok(await analyst.post(`/api/work-items/${runnerTask.ref}/links`, { kind: 'incident', reference: inc }));
    assert.equal(await sendSourceComments(), 1);
    assert.deepEqual(fake.comments.at(-1), { path: '/api/v4/projects/acme%2Fplatform/issues/2/notes', body: `Linked to ${inc} in Kernel`, auth: 'gl-token' });

    ok(await pm.put(`/api/teams/${platform.id}/mirror`, { source_id: gl.id, scope: 'acme/platform', comment_links: false }));
    ok(await analyst.post(`/api/work-items/${runnerTask.ref}/links`, { kind: 'problem', reference: prb }));
    assert.equal(await sendSourceComments(), 0, 'turned off for this mirror');
    ok(await pm.put(`/api/teams/${platform.id}/mirror`, { source_id: gl.id, scope: 'acme/platform' }));
  });

  test('GitHub webhook: a signed delivery updates and creates; deleted becomes removed; replays and bad signatures change nothing', async () => {
    const changed = { ...fake.github.get(2), title: 'Pay with one tap', state: 'closed', state_reason: 'completed' };
    assert.equal((await githubHook('edited', changed, { secret: 'wrong' })).status, 401);
    assert.equal((await shopItem(2)).title, 'Pay with one click');
    const id = randomUUID();
    ok(await githubHook('edited', changed, { id }), 202);
    const story = await shopItem(2);
    assert.deepEqual([story.title, story.status], ['Pay with one tap', 'done']);
    assert.equal(ok(await githubHook('edited', changed, { id }), 202).ignored, 'replayed delivery');
    fake.github.set(2, changed);

    const [, opened] = ghIssue(7, 'Found through the webhook', ['team-shop', 'bug']);
    ok(await githubHook('opened', opened), 202);
    assert.equal((await shopItem(7)).item_type, 'bug');
    ok(await githubHook('opened', ghIssue(8, 'Elsewhere', ['team-search'])[1]), 202);
    assert.equal(await shopItem(8), undefined, 'without the team\'s label');
    ok(await githubHook('deleted', opened), 202);
    const removed = await shopItem(7);
    assert.deepEqual([removed.status, removed.remove_reason], ['removed', 'Deleted in GitHub']);
  });

  test('GitLab webhook: the token is checked; a delivery without the iteration keeps the sprint; made confidential becomes removed', async () => {
    const bug = { ...fake.gitlab.get(1)! };
    assert.equal((await gitlabHook(bug, ['bug', 'workflow::Review'], { token: 'wrong' })).status, 401);
    ok(await gitlabHook(bug, ['bug', 'workflow::Review']), 202);
    const reviewed = await platformItem(1);
    assert.equal(reviewed.status, 'in_review');
    assert.equal(reviewed.sprint?.name, 'Sprint 1', 'the delivery did not name the iteration: kept');
    ok(await gitlabHook({ ...bug, confidential: true }, ['bug']), 202);
    const hidden = await platformItem(1);
    assert.deepEqual([hidden.status, hidden.remove_reason], ['removed', 'Made confidential in GitLab']);
  });

  test('reconciliation: deleted in the source, or without the label now, becomes removed with the reason', async () => {
    fake.github.delete(3);
    fake.github.set(1, { ...fake.github.get(1), labels: [{ name: 'epic' }] });
    const run = await sync(shop);
    assert.equal(run.status, 'succeeded', run.message);
    assert.equal(run.counts.removed, 2);
    assert.equal((await shopItem(3)).remove_reason, 'Deleted in GitHub');
    assert.equal((await shopItem(1)).remove_reason, 'Moved out of the mirrored area in GitHub');
    assert.equal((await sync(shop)).counts.removed, 0, 'once');
  });
});
