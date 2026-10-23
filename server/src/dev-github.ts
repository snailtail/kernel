// GitHub (#32): pull requests, issues, commits, workflow runs and releases. Deliveries are signed with
// X-Hub-Signature-256 (HMAC-SHA256 of the raw body), the strongest verification of the three platforms.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { badRequest } from './errors.js';
import { ciState, firstLine, iso, isRollback, pushCommits, type Adapter, type ItemType, type ParsedItem } from './dev-platform.js';

/** GitHub signs each delivery: X-Hub-Signature-256 = sha256=HMAC(secret, raw body). */
function verifyGitHubSignature(secret: string, raw: string, header: string | undefined) {
  if (!header?.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const HANDLED = new Set(['pull_request', 'issues', 'push', 'workflow_run', 'check_suite', 'release', 'deployment_status']);

export const github: Adapter = {
  label: 'GitHub',
  scopePattern: /^[\w.-]+\/[\w.-]+$/,
  scopeExample: 'owner/repo',
  events: ['Pull requests', 'Issues', 'Pushes', 'Workflow runs', 'Check suites', 'Releases', 'Deployment statuses'],

  parseUrl(u): ParsedItem | null {
    if (u.hostname !== 'github.com') return null;
    const m = u.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/(pull|issues|commit|actions\/runs|releases\/tag)\/([^/?#]+)/);
    if (!m) throw badRequest('Not a link to a pull request, issue, commit, workflow run or release');
    const [, owner, name, kind, key] = m;
    const item_type: ItemType = { pull: 'pull_request', issues: 'issue', commit: 'commit', 'actions/runs': 'workflow_run', 'releases/tag': 'release' }[kind] as ItemType;
    if ((item_type === 'pull_request' || item_type === 'issue' || item_type === 'workflow_run') && !/^\d+$/.test(key)) throw badRequest('That link has no number');
    if (item_type === 'commit' && !/^[0-9a-f]{7,40}$/i.test(key)) throw badRequest('That link has no commit id');
    const repo = `${owner}/${name}`;
    const path = { pull_request: 'pull', issue: 'issues', commit: 'commit', workflow_run: 'actions/runs', release: 'releases/tag' }[item_type as Exclude<ItemType, 'deployment'>];
    return { platform: 'github', base: 'https://github.com', repo, item_type, key: decodeURIComponent(key), url: `https://github.com/${repo}/${path}/${key}` };
  },

  async fetchStatus(item, token, get) {
    if (item.item_type === 'deployment') return {};
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const path = { pull_request: `pulls/${item.key}`, issue: `issues/${item.key}`, commit: `commits/${item.key}`, workflow_run: `actions/runs/${item.key}`, release: `releases/tags/${encodeURIComponent(item.key)}` }[item.item_type];
    const j = await get(`https://api.github.com/repos/${item.repo}/${path}`, headers);
    if (!j) return {};
    if (item.item_type === 'pull_request') return { title: j.title, state: j.merged_at ? 'merged' : j.draft ? 'draft' : j.state, author: j.user?.login, data: { sha: j.head?.sha, merge_sha: j.merge_commit_sha ?? undefined, merged_at: iso(j.merged_at) } };
    if (item.item_type === 'issue') return { title: j.title, state: j.state, author: j.user?.login };
    if (item.item_type === 'commit') return { title: firstLine(j.commit?.message), state: 'committed', author: j.author?.login ?? j.commit?.author?.name };
    if (item.item_type === 'workflow_run') return { title: j.display_title ?? j.name, state: j.conclusion ?? j.status, author: j.actor?.login };
    return { title: j.name || j.tag_name, state: j.draft ? 'draft' : j.prerelease ? 'prerelease' : 'published', author: j.author?.login };
  },

  verify: (req, raw, secret) => verifyGitHubSignature(secret, raw, req.headers['x-hub-signature-256'] as string | undefined),

  read(req, body) {
    const event = String(req.headers['x-github-event'] ?? '');
    const delivery = String(req.headers['x-github-delivery'] ?? '').slice(0, 100);
    if (!delivery) return null;
    if (event === 'ping') return { event, delivery, scope: '', ping: true };
    return { event: HANDLED.has(event) ? event : `unhandled:${event}`, delivery, scope: String(body?.repository?.full_name ?? '') };
  },

  inScope: (repositories, scope) => repositories.includes(scope),

  async handle(ctx, event, b, repo) {
    const base = { platform: 'github' as const, repo };
    if (event === 'pull_request' && b.pull_request) {
      const p = b.pull_request;
      const id = await ctx.upsert({
        ...base, item_type: 'pull_request', key: String(p.number), url: p.html_url, title: p.title,
        state: p.merged_at ? 'merged' : p.draft ? 'draft' : p.state, author: p.user?.login,
        data: { branch: p.head?.ref, base: p.base?.ref, sha: p.head?.sha, ...(p.merged_at && p.merge_commit_sha ? { merge_sha: p.merge_commit_sha } : {}), merged_at: iso(p.merged_at) },
      });
      return ctx.mention(id, `${p.title}\n${p.body ?? ''}\n${p.head?.ref ?? ''}`);
    }
    if (event === 'issues' && b.issue) {
      const i = b.issue;
      const id = await ctx.upsert({ ...base, item_type: 'issue', key: String(i.number), url: i.html_url, title: i.title, state: i.state, author: i.user?.login });
      return ctx.mention(id, `${i.title}\n${i.body ?? ''}`);
    }
    if (event === 'push' && Array.isArray(b.commits)) {
      return pushCommits(ctx, b.commits.map((c: any) => ({ sha: c.id, message: c.message, url: c.url, author: c.author?.username ?? c.author?.name })), [String(b.ref ?? '')], base);
    }
    if (event === 'workflow_run' && b.workflow_run) {
      const r = b.workflow_run;
      const prNumbers = (r.pull_requests ?? []).map((p: any) => String(p.number));
      const id = await ctx.upsert({
        ...base, item_type: 'workflow_run', key: String(r.id), url: r.html_url, title: `${r.name}: ${r.display_title ?? ''}`.trim(),
        state: r.conclusion ?? r.status, author: r.actor?.login, data: { branch: r.head_branch, sha: r.head_sha },
      });
      // A run belongs to the records its pull requests are linked to, and to refs in its title or branch.
      return ctx.mention(id, `${r.display_title ?? ''}\n${r.head_branch ?? ''}`, await ctx.refsOf(repo, 'pull_request', prNumbers));
    }
    if (event === 'check_suite' && b.check_suite) {
      for (const p of b.check_suite.pull_requests ?? []) await ctx.setChecks(repo, String(p.number), b.check_suite.conclusion ?? b.check_suite.status);
      return [];
    }
    if (event === 'release' && b.release) {
      const r = b.release;
      const id = await ctx.upsert({ ...base, item_type: 'release', key: String(r.tag_name), url: r.html_url, title: r.name || r.tag_name, state: r.draft ? 'draft' : r.prerelease ? 'prerelease' : 'published', author: r.author?.login });
      return ctx.mention(id, `${r.name ?? ''}\n${r.body ?? ''}`);
    }
    if (event === 'deployment_status' && b.deployment && b.deployment_status) {
      const d = b.deployment;
      const st = b.deployment_status;
      const link = [st.target_url, st.log_url].find((u) => /^https:\/\//.test(String(u ?? ''))) ?? `https://github.com/${repo}/deployments`;
      return ctx.deployed({
        repo, key: String(d.id), url: link, environment: String(st.environment ?? d.environment ?? ''), state: deployState(st.state),
        title: `${d.environment ?? 'Deployment'}: ${d.ref ?? String(d.sha ?? '').slice(0, 7)}`, author: d.creator?.login, sha: d.sha,
        rollback: d.task === 'rollback' || isRollback(d.description, st.description), started_at: d.created_at, finished_at: st.created_at,
        text: `${d.description ?? ''}\n${d.ref ?? ''}`,
      });
    }
    return [];
  },

  async postStatus(item, _base, token, post, s) {
    const sha = item.data.sha;
    if (!sha) return false;
    return post(`https://api.github.com/repos/${item.repo}/statuses/${sha}`, { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, {
      state: s.state, context: 'kernel/change', description: s.description, target_url: s.target_url,
    });
  },
};

/** GitHub deployment states on the shared scale (error and failure are both failures; inactive is superseded). */
function deployState(s: unknown) {
  if (s === 'error') return 'failure';
  if (s === 'inactive') return 'inactive';
  return ciState(s) ?? 'unknown';
}
