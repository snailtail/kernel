// GitLab (#32), gitlab.com and self-hosted: merge requests, issues, commits, pipelines and releases. Deliveries carry
// the source's secret in X-Gitlab-Token (no signature over the body), compared in constant time; replays are refused
// on X-Gitlab-Event-UUID.
import { badRequest } from './errors.js';
import { ciState, firstLine, iso, pushCommits, sameSecret, type Adapter, type ItemType, type ParsedItem } from './dev-platform.js';

export const GITLAB_COM = 'https://gitlab.com';
const SEGMENT: Record<ItemType, string> = { pull_request: 'merge_requests', issue: 'issues', commit: 'commit', workflow_run: 'pipelines', release: 'releases', deployment: 'environments' };
const KIND: Record<string, ItemType> = { merge_requests: 'pull_request', issues: 'issue', work_items: 'issue', commit: 'commit', pipelines: 'workflow_run', releases: 'release' };
// Confidential issues are not handled: their titles would become visible to everyone who can see the Kernel record.
const HANDLED: Record<string, string> = { 'Merge Request Hook': 'merge_request', 'Issue Hook': 'issue', 'Push Hook': 'push', 'Pipeline Hook': 'pipeline', 'Release Hook': 'release', 'Deployment Hook': 'deployment' };

const mrState = (state: unknown, draft: unknown) => (state === 'opened' ? (draft ? 'draft' : 'open') : state === 'locked' ? 'closed' : String(state ?? 'unknown'));
const issueState = (state: unknown) => (state === 'opened' ? 'open' : String(state ?? 'unknown'));

export const gitlab: Adapter = {
  label: 'GitLab',
  scopePattern: /^[\w.-]+(\/[\w.-]+)+$/,
  scopeExample: 'group/project',
  events: ['Merge request events', 'Issues events', 'Push events', 'Pipeline events', 'Releases events', 'Deployment events'],

  parseUrl(u, bases): ParsedItem | null {
    const base = [GITLAB_COM, ...bases].find((b) => {
      const p = new URL(b);
      return u.origin === p.origin && (u.pathname + '/').startsWith(p.pathname.replace(/\/?$/, '/'));
    });
    if (!base) return null;
    const rest = u.pathname.slice(new URL(base).pathname.replace(/\/$/, '').length);
    const m = rest.match(/^\/([\w.-]+(?:\/[\w.-]+)+)\/-\/(merge_requests|issues|work_items|commit|pipelines|releases)\/([^/?#]+)/);
    if (!m) throw badRequest('Not a link to a merge request, issue, commit, pipeline or release');
    const [, repo, kind, rawKey] = m;
    const item_type = KIND[kind];
    const key = decodeURIComponent(rawKey);
    if (item_type !== 'commit' && item_type !== 'release' && !/^\d+$/.test(key)) throw badRequest('That link has no number');
    if (item_type === 'commit' && !/^[0-9a-f]{7,40}$/i.test(key)) throw badRequest('That link has no commit id');
    return { platform: 'gitlab', base, repo, item_type, key, url: `${base}/${repo}/-/${SEGMENT[item_type]}/${encodeURIComponent(key)}` };
  },

  async fetchStatus(item, token, get) {
    if (item.item_type === 'deployment') return {};
    const api = `${item.base}/api/v4/projects/${encodeURIComponent(item.repo)}`;
    const headers: Record<string, string> = token ? { 'PRIVATE-TOKEN': token } : {};
    const path = { pull_request: `merge_requests/${item.key}`, issue: `issues/${item.key}`, commit: `repository/commits/${item.key}`, workflow_run: `pipelines/${item.key}`, release: `releases/${encodeURIComponent(item.key)}`, deployment: '' }[item.item_type];
    const j = await get(`${api}/${path}`, headers);
    if (!j) return {};
    if (item.item_type === 'pull_request') return { title: j.title, state: mrState(j.state, j.draft ?? j.work_in_progress), checks: ciState(j.head_pipeline?.status) ?? null, author: j.author?.username, data: { sha: j.sha ?? undefined, merge_sha: j.merge_commit_sha ?? undefined, merged_at: iso(j.merged_at) } };
    if (item.item_type === 'issue') return { title: j.title, state: issueState(j.state), author: j.author?.username };
    if (item.item_type === 'commit') return { title: j.title ?? firstLine(j.message), state: 'committed', author: j.author_name };
    if (item.item_type === 'workflow_run') return { title: `${j.name || 'Pipeline'}: ${j.ref ?? ''}`.trim(), state: ciState(j.status), author: j.user?.username };
    return { title: j.name || j.tag_name, state: j.upcoming_release ? 'upcoming' : 'published', author: j.author?.username };
  },

  verify: (req, _raw, secret) => sameSecret(req.headers['x-gitlab-token'] as string | undefined, secret),

  read(req, body) {
    const header = String(req.headers['x-gitlab-event'] ?? '');
    const delivery = String(req.headers['x-gitlab-event-uuid'] ?? req.headers['idempotency-key'] ?? '').slice(0, 100);
    if (!delivery) return null;
    return { event: HANDLED[header] ?? `unhandled:${header}`, delivery, scope: String(body?.project?.path_with_namespace ?? '') };
  },

  inScope: (repositories, scope) => repositories.some((r) => r.toLowerCase() === scope.toLowerCase()),

  async handle(ctx, event, b, repo) {
    const base = { platform: 'gitlab' as const, repo };
    const a = b.object_attributes ?? {};
    if (event === 'merge_request' && a.iid) {
      const id = await ctx.upsert({
        ...base, item_type: 'pull_request', key: String(a.iid), url: a.url, title: a.title,
        state: mrState(a.state, a.draft ?? a.work_in_progress), author: b.user?.username,
        data: { branch: a.source_branch, base: a.target_branch, sha: a.last_commit?.id, ...(a.merge_commit_sha ? { merge_sha: a.merge_commit_sha } : {}),
          // The hook has no merged_at of its own: the merge event's time is when it was merged; later edits keep it.
          ...(iso(a.merged_at) ?? (a.action === 'merge' ? iso(a.updated_at) : undefined) ? { merged_at: iso(a.merged_at) ?? iso(a.updated_at) } : {}) },
      });
      return ctx.mention(id, `${a.title ?? ''}\n${a.description ?? ''}\n${a.source_branch ?? ''}`);
    }
    if (event === 'issue' && a.iid && !a.confidential) {
      const id = await ctx.upsert({ ...base, item_type: 'issue', key: String(a.iid), url: a.url, title: a.title, state: issueState(a.state), author: b.user?.username });
      return ctx.mention(id, `${a.title ?? ''}\n${a.description ?? ''}`);
    }
    if (event === 'push' && Array.isArray(b.commits)) {
      return pushCommits(ctx, b.commits.map((c: any) => ({ sha: c.id, message: c.message, url: c.url, author: c.author?.name })), [String(b.ref ?? '')], base);
    }
    if (event === 'pipeline' && a.id) {
      const state = ciState(a.status);
      const mr = b.merge_request?.iid ? [String(b.merge_request.iid)] : [];
      const id = await ctx.upsert({
        ...base, item_type: 'workflow_run', key: String(a.id), url: `${b.project?.web_url}/-/pipelines/${a.id}`, title: `${a.name || 'Pipeline'}: ${a.ref ?? ''}`.trim(),
        state, author: b.user?.username, data: { branch: a.ref, sha: a.sha },
      });
      // A merge request pipeline is that merge request's checks, and the pipeline follows its links.
      if (mr.length && state) await ctx.setChecks(repo, mr[0], state);
      return ctx.mention(id, `${a.ref ?? ''}\n${b.commit?.message ?? ''}`, await ctx.refsOf(repo, 'pull_request', mr));
    }
    if (event === 'release' && b.tag) {
      const id = await ctx.upsert({ ...base, item_type: 'release', key: String(b.tag), url: b.url, title: b.name || b.tag, state: b.action === 'delete' ? 'deleted' : 'published' });
      return ctx.mention(id, `${b.name ?? ''}\n${b.description ?? ''}`);
    }
    if (event === 'deployment' && b.deployment_id) {
      const sha = String(b.commit_url ?? '').match(/\/commit\/([0-9a-f]{7,40})$/i)?.[1];
      return ctx.deployed({
        repo, key: String(b.deployment_id), url: b.deployable_url || `${b.project?.web_url}/-/environments`, environment: String(b.environment ?? ''), state: ciState(b.status) ?? 'unknown',
        title: `${b.environment ?? 'Deployment'}: ${b.ref ?? b.short_sha ?? ''}`.trim(), author: b.user?.username, sha,
        finished_at: b.status_changed_at, text: `${b.ref ?? ''}\n${b.commit_title ?? ''}`,
      });
    }
    return [];
  },

  async postStatus(item, base, token, post, s) {
    const sha = item.data.sha;
    if (!sha) return false;
    return post(`${base}/api/v4/projects/${encodeURIComponent(item.repo)}/statuses/${sha}`, { 'PRIVATE-TOKEN': token }, {
      state: s.state === 'failure' ? 'failed' : s.state, name: 'kernel/change', description: s.description, target_url: s.target_url,
    });
  },
};
