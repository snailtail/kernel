// Azure DevOps (#32), dev.azure.com and *.visualstudio.com: pull requests, work items, commits, pipeline runs and
// releases. Service hooks cannot sign their deliveries, so they carry the source's secret as the Basic auth password:
// weaker than GitHub's HMAC (whoever sees one delivery can send others), so they are only accepted over HTTPS, from an
// allowlisted organisation/project, and replays are refused on notificationId + id.
import { badRequest } from '../core/errors.js';
import { ciState, firstLine, iso, isRollback, pushCommits, sameSecret, PLATFORM_LABELS, type Adapter, type CallJson, type MirroredItem, type Mirroring, type MirrorPlace, type ParsedItem } from './dev-platform.js';

export const AZURE_DEVOPS = 'https://dev.azure.com';
const HANDLED = new Set(['git.pullrequest.created', 'git.pullrequest.updated', 'git.pullrequest.merged', 'workitem.created', 'workitem.updated', 'workitem.deleted', 'workitem.restored', 'git.push', 'build.complete', 'ms.vss-release.deployment-completed-event']);
const enc = encodeURIComponent;
const web = (org: string, project: string) => `${AZURE_DEVOPS}/${enc(org)}/${enc(project)}`;

/** The organisation in https://dev.azure.com/{org}/… or https://{org}.visualstudio.com/…. */
function orgOf(raw: unknown): string | null {
  try {
    const u = new URL(String(raw));
    if (u.hostname === 'dev.azure.com') return decodeURIComponent(u.pathname.split('/')[1] ?? '') || null;
    const m = u.hostname.match(/^([\w-]+)\.visualstudio\.com$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const prState = (status: unknown, draft: unknown) => (status === 'active' ? (draft ? 'draft' : 'open') : status === 'completed' ? 'merged' : status === 'abandoned' ? 'closed' : String(status ?? 'unknown'));
// Identities come as an object or as "Name <email>"; only the name is kept.
const person = (p: any) => (typeof p === 'string' ? p.replace(/\s*<[^>]*>\s*$/, '') : p?.displayName ?? p?.name);
const buildState = (r: any) => (r.status === 'completed' ? ciState(r.result) : ciState(r.status));
const branchName = (ref: unknown) => String(ref ?? '').replace(/^refs\/heads\//, '');

// ---- Mirrored backlogs (#168) ------------------------------------------------------------------------------------

const split = (scope: string) => ({ org: scope.slice(0, scope.indexOf('/')), project: scope.slice(scope.indexOf('/') + 1) });
const basic = (token: string | null): Record<string, string> => (token ? { Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}` } : {});
/** Work item ids are unique per organisation. */
const externalId = (org: string, id: unknown) => `${org.toLowerCase()}#${id}`;
const idOf = (externalId: string) => externalId.slice(externalId.indexOf('#') + 1);
// Identities come as an object or as "Name <email>"; the e-mail address matches a Kernel user.
const emailOf = (p: any) => {
  const v = typeof p === 'string' ? p.match(/<([^>]+@[^>]+)>\s*$/)?.[1] : p?.uniqueName;
  return typeof v === 'string' && v.includes('@') ? v.toLowerCase() : null;
};
const numberOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const MIRROR_FIELDS = ['System.Id', 'System.Title', 'System.WorkItemType', 'System.State', 'System.AreaPath', 'System.IterationPath', 'System.AssignedTo', 'System.Parent', 'Microsoft.VSTS.Scheduling.StoryPoints', 'Microsoft.VSTS.Scheduling.Effort'];

/** A work item's fields (a delivery's revision, or the API's) in the source's words. Agile has story points, Scrum effort. */
function mirroredFrom(base: string, org: string, project: string, id: unknown, f: Record<string, any>): MirroredItem {
  return {
    external_id: externalId(org, id),
    url: `${base}/${enc(org)}/${enc(project)}/_workitems/edit/${id}`,
    title: String(f['System.Title'] ?? ''),
    type: String(f['System.WorkItemType'] ?? ''),
    state: String(f['System.State'] ?? ''),
    area: String(f['System.AreaPath'] ?? ''),
    iteration: String(f['System.IterationPath'] ?? ''),
    points: numberOf(f['Microsoft.VSTS.Scheduling.StoryPoints'] ?? f['Microsoft.VSTS.Scheduling.Effort']),
    assignee_email: emailOf(f['System.AssignedTo']),
    parent_external_id: f['System.Parent'] ? externalId(org, f['System.Parent']) : null,
  };
}

/** The items by id, 200 a request (the API's limit); deleted ones are left out. */
async function batch(place: MirrorPlace, ids: (string | number)[], token: string | null, call: CallJson) {
  const { org, project } = split(place.scope);
  const out: MirroredItem[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const j = await call(`${place.base}/${enc(org)}/${enc(project)}/_apis/wit/workitemsbatch?api-version=7.1`, {
      method: 'POST', headers: basic(token), body: { ids: ids.slice(i, i + 200).map(Number), fields: MIRROR_FIELDS, errorPolicy: 'omit' },
    });
    for (const w of j?.value ?? []) if (w?.id) out.push(mirroredFrom(place.base, org, project, w.id, w.fields ?? {}));
  }
  return out;
}

/**
 * Azure DevOps backlogs: the items under an area path. The default mapping covers the Agile, Scrum, CMMI and Basic
 * processes; a Feature sits between an epic and its stories there, and becomes an epic here (Kernel has three levels).
 */
export const azureMirror: Mirroring = {
  areaName: 'area path',
  types: { epic: 'epic', feature: 'epic', 'user story': 'story', 'product backlog item': 'story', requirement: 'story', issue: 'story', bug: 'bug', task: 'task' },
  states: {
    new: 'new', proposed: 'new', 'to do': 'new', approved: 'ready', ready: 'ready', active: 'in_progress', committed: 'in_progress', doing: 'in_progress',
    'in progress': 'in_progress', resolved: 'in_review', closed: 'done', done: 'done', completed: 'done', removed: 'removed',
  },
  covers(place, area) {
    if (!place.area) return true;
    const [a, p] = [area.toLowerCase(), place.area.toLowerCase()];
    return a === p || a.startsWith(`${p}\\`);
  },
  async list(place, token, call) {
    const { org, project } = split(place.scope);
    const under = place.area ? ` AND [System.AreaPath] UNDER '${place.area.replaceAll("'", "''")}'` : '';
    const j = await call(`${place.base}/${enc(org)}/${enc(project)}/_apis/wit/wiql?api-version=7.1`, {
      method: 'POST', headers: basic(token), body: { query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project${under}` },
    });
    if (!Array.isArray(j?.workItems)) throw Object.assign(new Error('Azure DevOps did not return a list of work items'), { kind: 'not_a_list' });
    return batch(place, j.workItems.map((w: any) => w.id), token, call);
  },
  lookup: (place, externalIds, token, call) => batch(place, externalIds.map(idOf), token, call),
  async comment(place, externalId, body, token, call) {
    const { org, project } = split(place.scope);
    await call(`${place.base}/${enc(org)}/${enc(project)}/_apis/wit/workItems/${idOf(externalId)}/comments?api-version=7.1-preview.4`, { method: 'POST', headers: basic(token), body: { text: body } });
  },
};

/** The project of a delivery's resource, wherever this event type keeps it. */
function projectOf(b: any): string {
  const r = b?.resource ?? {};
  const fields = r.revision?.fields ?? r.fields ?? {};
  return String(r.repository?.project?.name ?? fields['System.TeamProject'] ?? r.project?.name ?? r.definition?.project?.name ?? '');
}

export const azureDevOps: Adapter = {
  label: PLATFORM_LABELS.azure_devops,
  scopePattern: /^[\w.-]+\/[\w .-]+$/,
  scopeExample: 'organisation/project',
  events: ['Pull request created', 'Pull request updated', 'Pull request merge attempted', 'Work item created', 'Work item updated', 'Work item deleted', 'Work item restored', 'Code pushed', 'Build completed', 'Release deployment completed'],
  httpsOnly: true,

  parseUrl(u): ParsedItem | null {
    let parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    let org: string | undefined;
    if (u.hostname === 'dev.azure.com') org = parts.shift();
    else if (/^[\w-]+\.visualstudio\.com$/.test(u.hostname)) org = u.hostname.split('.')[0];
    else return null;
    if (parts[0] === 'DefaultCollection') parts = parts.slice(1);
    const project = parts.shift();
    if (!org || !project) throw badRequest('Not a link to a pull request, work item, commit, pipeline run or release');
    const base = { platform: 'azure_devops' as const, base: AZURE_DEVOPS, repo: `${org}/${project}` };
    const root = web(org, project);
    const [area, a, b, c] = parts;
    if (area === '_git' && a && b === 'pullrequest' && /^\d+$/.test(c ?? '')) {
      return { ...base, item_type: 'pull_request', key: c, url: `${root}/_git/${enc(a)}/pullrequest/${c}`, data: { repository: a } };
    }
    if (area === '_git' && a && b === 'commit' && /^[0-9a-f]{7,40}$/i.test(c ?? '')) {
      return { ...base, item_type: 'commit', key: c, url: `${root}/_git/${enc(a)}/commit/${c}`, data: { repository: a } };
    }
    if (area === '_workitems' && a === 'edit' && /^\d+$/.test(b ?? '')) return { ...base, item_type: 'issue', key: b, url: `${root}/_workitems/edit/${b}` };
    const buildId = u.searchParams.get('buildId');
    if (area === '_build' && /^\d+$/.test(buildId ?? '')) return { ...base, item_type: 'workflow_run', key: buildId!, url: `${root}/_build/results?buildId=${buildId}` };
    const releaseId = u.searchParams.get('releaseId');
    if ((area === '_releaseProgress' || area === '_release') && /^\d+$/.test(releaseId ?? '')) return { ...base, item_type: 'release', key: releaseId!, url: `${root}/_releaseProgress?releaseId=${releaseId}` };
    throw badRequest('Not a link to a pull request, work item, commit, pipeline run or release');
  },

  async fetchStatus(item, token, get) {
    if (item.item_type === 'deployment') return {};
    const [org, project] = [item.repo.slice(0, item.repo.indexOf('/')), item.repo.slice(item.repo.indexOf('/') + 1)];
    const headers: Record<string, string> = token ? { Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}` } : {};
    const api = `${web(org, project)}/_apis`;
    const v = 'api-version=7.1';
    if (item.item_type === 'pull_request') {
      const j = await get(`${api}/git/pullrequests/${item.key}?${v}`, headers);
      return j ? { title: j.title, state: prState(j.status, j.isDraft), author: person(j.createdBy), data: { sha: j.lastMergeSourceCommit?.commitId, merge_sha: j.lastMergeCommit?.commitId, merged_at: j.status === 'completed' ? iso(j.closedDate) : undefined } } : {};
    }
    if (item.item_type === 'issue') {
      const j = await get(`${api}/wit/workitems/${item.key}?${v}`, headers);
      return j ? { title: j.fields?.['System.Title'], state: String(j.fields?.['System.State'] ?? 'unknown').toLowerCase(), author: person(j.fields?.['System.CreatedBy']) } : {};
    }
    if (item.item_type === 'commit') {
      const repository = String(item.data?.repository ?? '');
      if (!repository) return {};
      const j = await get(`${api}/git/repositories/${enc(repository)}/commits/${item.key}?${v}`, headers);
      return j ? { title: firstLine(j.comment), state: 'committed', author: person(j.author) } : {};
    }
    if (item.item_type === 'workflow_run') {
      const j = await get(`${api}/build/builds/${item.key}?${v}`, headers);
      return j ? { title: `${j.definition?.name ?? 'Pipeline'}: ${j.buildNumber ?? ''}`.trim(), state: buildState(j), author: person(j.requestedFor) } : {};
    }
    const j = await get(`https://vsrm.dev.azure.com/${enc(org)}/${enc(project)}/_apis/release/releases/${item.key}?${v}`, headers);
    return j ? { title: j.name, state: String(j.status ?? 'unknown').toLowerCase(), author: person(j.createdBy) } : {};
  },

  // The service hook's "Basic authentication" password is the source's secret; the user name is not checked.
  verify(req, _raw, secret) {
    const header = String(req.headers.authorization ?? '');
    if (!/^Basic\s+/i.test(header)) return false;
    const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return colon >= 0 && sameSecret(decoded.slice(colon + 1), secret);
  },

  read(_req, body) {
    if (body?.notificationId === undefined || !body?.id) return null;
    const event = String(body.eventType ?? '');
    const org = orgOf(body.resourceContainers?.account?.baseUrl ?? body.resourceContainers?.collection?.baseUrl ?? body.resource?.url);
    const project = projectOf(body);
    return { event: HANDLED.has(event) ? event : `unhandled:${event}`, delivery: `${body.notificationId}:${body.id}`.slice(0, 100), scope: org && project ? `${org}/${project}` : '' };
  },

  inScope: (repositories, scope) => repositories.some((r) => r.toLowerCase() === scope.toLowerCase()),

  async handle(ctx, event, b, scope) {
    const [org, project] = [scope.slice(0, scope.indexOf('/')), scope.slice(scope.indexOf('/') + 1)];
    const root = web(org, project);
    const base = { platform: 'azure_devops' as const, repo: scope };
    const r = b.resource ?? {};
    if (event.startsWith('git.pullrequest.') && r.pullRequestId) {
      const repository = String(r.repository?.name ?? '');
      const id = await ctx.upsert({
        ...base, item_type: 'pull_request', key: String(r.pullRequestId), url: `${root}/_git/${enc(repository)}/pullrequest/${r.pullRequestId}`, title: r.title,
        state: prState(r.status, r.isDraft), author: person(r.createdBy),
        data: { repository, branch: branchName(r.sourceRefName), base: branchName(r.targetRefName), sha: r.lastMergeSourceCommit?.commitId, ...(r.status === 'completed' && r.lastMergeCommit?.commitId ? { merge_sha: r.lastMergeCommit.commitId } : {}), ...(r.status === 'completed' ? { merged_at: iso(r.closedDate) } : {}) },
      });
      return ctx.mention(id, `${r.title ?? ''}\n${r.description ?? ''}\n${branchName(r.sourceRefName)}`);
    }
    if (event.startsWith('workitem.')) {
      const itemId = r.workItemId ?? r.id;
      const fields = r.revision?.fields ?? r.fields ?? {};
      if (!itemId) return [];
      if (event === 'workitem.deleted') {
        await ctx.mirrored({ external_id: externalId(org, itemId), deleted: true });
        return [];
      }
      await ctx.mirrored(mirroredFrom(AZURE_DEVOPS, org, project, itemId, fields));
      const id = await ctx.upsert({
        ...base, item_type: 'issue', key: String(itemId), url: `${root}/_workitems/edit/${itemId}`, title: fields['System.Title'],
        state: fields['System.State'] ? String(fields['System.State']).toLowerCase() : undefined, author: person(fields['System.CreatedBy']),
      });
      return ctx.mention(id, `${fields['System.Title'] ?? ''}\n${fields['System.Description'] ?? ''}`);
    }
    if (event === 'git.push' && Array.isArray(r.commits)) {
      const repository = String(r.repository?.name ?? '');
      const commits = r.commits.map((c: any) => ({ sha: c.commitId, message: c.comment, url: `${root}/_git/${enc(repository)}/commit/${c.commitId}`, author: person(c.author), data: { repository } }));
      return pushCommits(ctx, commits, (r.refUpdates ?? []).map((u: any) => String(u.name ?? '')), base);
    }
    if (event === 'build.complete' && r.id) {
      const state = buildState(r);
      // A pull request validation build runs on refs/pull/{id}/merge: it is that pull request's checks.
      const pr = String(r.sourceBranch ?? '').match(/^refs\/pull\/(\d+)\/merge$/)?.[1];
      const id = await ctx.upsert({
        ...base, item_type: 'workflow_run', key: String(r.id), url: `${root}/_build/results?buildId=${r.id}`, title: `${r.definition?.name ?? 'Pipeline'}: ${r.buildNumber ?? ''}`.trim(),
        state, author: person(r.requestedFor), data: { branch: branchName(r.sourceBranch), sha: r.sourceVersion },
      });
      if (pr && state) await ctx.setChecks(scope, pr, state);
      return ctx.mention(id, `${r.buildNumber ?? ''}\n${branchName(r.sourceBranch)}`, await ctx.refsOf(scope, 'pull_request', pr ? [pr] : []));
    }
    if (event === 'ms.vss-release.deployment-completed-event' && r.environment?.id) {
      // A classic release: one deployment per release, stage and attempt.
      const env = r.environment;
      const release = env.release ?? r.release ?? {};
      const attempt = Array.isArray(env.deploySteps) ? env.deploySteps.length : 1;
      return ctx.deployed({
        repo: scope, key: `${release.id ?? env.releaseId}-${env.id}-${attempt}`, url: `${root}/_releaseProgress?releaseId=${release.id ?? env.releaseId}&environmentId=${env.id}`,
        environment: String(env.name ?? ''), state: env.status === 'rejected' ? 'failure' : ciState(env.status) ?? 'unknown', title: `${env.name ?? 'Stage'}: ${release.name ?? ''}`.trim(),
        author: person(env.deploySteps?.at(-1)?.requestedFor), rollback: isRollback(release.name, release.description, env.deploySteps?.at(-1)?.reason),
        started_at: env.deploySteps?.at(-1)?.queuedOn, finished_at: env.deploySteps?.at(-1)?.lastModifiedOn, text: `${release.name ?? ''}\n${release.description ?? ''}`,
      });
    }
    return [];
  },

  async postStatus(item, _base, token, post, s) {
    const [org, project] = [item.repo.slice(0, item.repo.indexOf('/')), item.repo.slice(item.repo.indexOf('/') + 1)];
    const repository = String(item.data.repository ?? '');
    if (!repository) return false;
    return post(`${web(org, project)}/_apis/git/repositories/${enc(repository)}/pullRequests/${item.key}/statuses?api-version=7.1`, { Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}` }, {
      state: { success: 'succeeded', pending: 'pending', failure: 'failed' }[s.state], description: s.description, targetUrl: s.target_url, context: { genre: 'kernel', name: 'change' },
    });
  },
};
