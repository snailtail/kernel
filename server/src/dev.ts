// Dev platform links (#32): where code fixes happen. A pasted GitHub URL becomes a linked item with live status, and
// a GitHub webhook keeps items current and links them when a PR, branch, commit or run mentions a Kernel ref
// ("Fixes CHG-17", "prb-42", "INC000012"). Azure DevOps and GitLab can follow the same model.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { config } from './config.js';
import { asSystem, contextStore } from './context.js';
import { query, tx } from './db.js';
import { badRequest, forbidden, HttpError, notFound, unauthorized } from './errors.js';
import { logger } from './log.js';
import { outboundFetch } from './outbound.js';
import { authorize, type Action } from './policy.js';
import type { Db } from './problems.js';
import { typeForRef } from './records.js';
import { decryptSecret, encryptSecret } from './secrets.js';

export const ITEM_TYPES = ['pull_request', 'issue', 'commit', 'workflow_run', 'release'] as const;
type ItemType = (typeof ITEM_TYPES)[number];
const WRITE: Record<string, Action> = { problem: 'problem.link', change: 'change.update', incident: 'incident.update' };
const LOG: Record<string, [string, string, string]> = {
  problem: ['problem_activity', 'problem_id', 'problems'],
  change: ['change_activity', 'change_id', 'changes'],
  incident: ['incident_activity', 'incident_id', 'incidents'],
};

export interface ParsedItem { platform: 'github'; repo: string; item_type: ItemType; key: string; url: string }

/** A GitHub URL as an item: pull request, issue, commit, workflow run or release. */
export function parseDevUrl(raw: string): ParsedItem {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw badRequest('Paste the link to a pull request, issue, commit, workflow run or release');
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw badRequest('Only github.com links are supported so far');
  const m = u.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/(pull|issues|commit|actions\/runs|releases\/tag)\/([^/?#]+)/);
  if (!m) throw badRequest('Not a link to a pull request, issue, commit, workflow run or release');
  const [, owner, name, kind, key] = m;
  const item_type: ItemType = { pull: 'pull_request', issues: 'issue', commit: 'commit', 'actions/runs': 'workflow_run', 'releases/tag': 'release' }[kind] as ItemType;
  if ((item_type === 'pull_request' || item_type === 'issue' || item_type === 'workflow_run') && !/^\d+$/.test(key)) throw badRequest('That link has no number');
  if (item_type === 'commit' && !/^[0-9a-f]{7,40}$/i.test(key)) throw badRequest('That link has no commit id');
  const repo = `${owner}/${name}`;
  const path = { pull_request: 'pull', issue: 'issues', commit: 'commit', workflow_run: 'actions/runs', release: 'releases/tag' }[item_type];
  return { platform: 'github', repo, item_type, key: decodeURIComponent(key), url: `https://github.com/${repo}/${path}/${key}` };
}

/**
 * Kernel refs mentioned in free text: CHG000017 or CHG-000017, exactly six digits, so another tool's numbers
 * (ServiceNow's INC0010001) are never mistaken for Kernel records.
 */
export function refsIn(text: string) {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(PRB|CHG|INC)-?(\d{6})\b/gi)) out.add(`${m[1].toUpperCase()}${m[2]}`);
  return [...out];
}

async function upsertItem(db: Db, item: ParsedItem & { title?: string; state?: string; checks?: string | null; author?: string; environment?: string; data?: object }) {
  const { rows } = await db.query(
    `INSERT INTO dev_items (platform, repo, item_type, key, url, title, state, checks, author, environment, data)
     VALUES ($1, $2, $3, $4, $5, coalesce($6, ''), coalesce($7, 'unknown'), $8, coalesce($9, ''), coalesce($10, ''), coalesce($11::jsonb, '{}'))
     ON CONFLICT (platform, repo, item_type, key) DO UPDATE SET
       title = coalesce(nullif($6, ''), dev_items.title), state = coalesce($7, dev_items.state), checks = coalesce($8, dev_items.checks),
       author = coalesce(nullif($9, ''), dev_items.author), environment = coalesce(nullif($10, ''), dev_items.environment),
       data = dev_items.data || coalesce($11::jsonb, '{}'), updated_at = now()
     RETURNING id`,
    [item.platform, item.repo, item.item_type, item.key, item.url, item.title ?? null, item.state ?? null, item.checks ?? null, item.author ?? null, item.environment ?? null, item.data ? JSON.stringify(item.data) : null],
  );
  return rows[0].id as number;
}

async function linkItem(db: Db, itemId: number, ref: string, via: 'manual' | 'webhook' | 'mcp', userId: number | null) {
  const type = typeForRef(ref).type;
  const [logTable, col, table] = LOG[type];
  const { rows: rec } = await db.query(`SELECT id FROM ${table} WHERE ref = $1`, [ref]);
  if (!rec[0]) throw notFound(`${ref} not found`);
  const { rowCount } = await db.query('INSERT INTO dev_item_links (dev_item_id, record_type, record_ref, linked_by, via) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [itemId, type, ref, userId, via]);
  if (!rowCount) return false;
  const { rows: item } = await db.query('SELECT repo, item_type, key, title FROM dev_items WHERE id = $1', [itemId]);
  const i = item[0];
  await db.query(`INSERT INTO ${logTable} (${col}, user_id, kind, body, data) VALUES ($1, $2, 'link', $3, $4)`, [
    rec[0].id, userId, `Linked ${label(i)}${via === 'webhook' ? ' (mentioned on GitHub)' : ''}`, JSON.stringify({ kind: 'dev_item', dev_item_id: itemId, action: 'add' }),
  ]);
  return true;
}

const label = (i: { repo: string; item_type: string; key: string }) =>
  `${{ pull_request: 'PR', issue: 'issue', commit: 'commit', workflow_run: 'run', release: 'release' }[i.item_type] ?? i.item_type} ${i.repo}${i.item_type === 'commit' ? `@${i.key.slice(0, 7)}` : i.item_type === 'release' ? ` ${i.key}` : `#${i.key}`}`;

/** Title and status from the GitHub API (best effort: public repositories, or with a source's token). */
async function fetchStatus(item: ParsedItem) {
  if (process.env.KERNEL_DEV_STATUS_FETCH === 'false') return {}; // tests and air-gapped installations
  const { rows } = await query("SELECT api_base, api_token FROM dev_sources WHERE enabled AND platform = 'github' AND (cardinality(repositories) = 0 OR $1 = ANY(repositories)) ORDER BY api_token IS NULL LIMIT 1", [item.repo]);
  const base = rows[0]?.api_base ?? 'https://api.github.com';
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'Kernel', 'X-GitHub-Api-Version': '2022-11-28' };
  if (rows[0]?.api_token) headers.Authorization = `Bearer ${decryptSecret(rows[0].api_token)}`;
  const path = { pull_request: `pulls/${item.key}`, issue: `issues/${item.key}`, commit: `commits/${item.key}`, workflow_run: `actions/runs/${item.key}`, release: `releases/tags/${encodeURIComponent(item.key)}` }[item.item_type];
  try {
    const res = await outboundFetch(`${base}/repos/${item.repo}/${path}`, { headers, timeoutMs: 5000, maxBytes: 500_000 });
    // Rate-limited (403/429) or not found: the link is kept, and the next webhook delivery fills in the status.
    if (!res.ok) return {};
    const j = JSON.parse(res.body);
    if (item.item_type === 'pull_request') return { title: j.title, state: j.merged_at ? 'merged' : j.draft ? 'draft' : j.state, author: j.user?.login };
    if (item.item_type === 'issue') return { title: j.title, state: j.state, author: j.user?.login };
    if (item.item_type === 'commit') return { title: String(j.commit?.message ?? '').split('\n')[0], state: 'committed', author: j.author?.login ?? j.commit?.author?.name };
    if (item.item_type === 'workflow_run') return { title: j.display_title ?? j.name, state: j.conclusion ?? j.status, author: j.actor?.login };
    return { title: j.name || j.tag_name, state: j.draft ? 'draft' : j.prerelease ? 'prerelease' : 'published', author: j.author?.login };
  } catch {
    return {};
  }
}

// ---- Links from Kernel ------------------------------------------------------------------------------------------

export async function addDevLink(user: User, ref: string, url: string, via: 'manual' | 'mcp' = 'manual') {
  const t = typeForRef(ref);
  if (!WRITE[t.type]) throw badRequest('Dev links belong on problems, changes and incidents');
  authorize(user, WRITE[t.type]);
  await t.get(user, ref.toUpperCase()); // visible to the caller (404 otherwise)
  const parsed = parseDevUrl(url);
  const status = await fetchStatus(parsed);
  await tx(async (db) => {
    const id = await upsertItem(db, { ...parsed, ...status });
    await linkItem(db, id, ref.toUpperCase(), via, user.id);
  });
  return listDevLinks(user, ref);
}

export async function removeDevLink(user: User, ref: string, itemId: number) {
  const t = typeForRef(ref);
  authorize(user, WRITE[t.type]);
  const { rowCount } = await query('DELETE FROM dev_item_links WHERE dev_item_id = $1 AND record_type = $2 AND record_ref = $3', [itemId, t.type, ref.toUpperCase()]);
  if (!rowCount) throw notFound('Link not found');
  return listDevLinks(user, ref);
}

export async function listDevLinks(user: User, ref: string) {
  const t = typeForRef(ref);
  authorize(user, t.readAction);
  const { rows } = await query(
    `SELECT d.id, d.platform, d.repo, d.item_type, d.key, d.url, d.title, d.state, d.checks, d.author, d.environment, d.updated_at, l.via, l.created_at AS linked_at
     FROM dev_item_links l JOIN dev_items d ON d.id = l.dev_item_id WHERE l.record_type = $1 AND l.record_ref = $2
     ORDER BY d.item_type, d.updated_at DESC`,
    [t.type, ref.toUpperCase()],
  );
  return rows;
}

/** For change guidance and agents: are all linked pull requests merged? */
export async function pullRequestSummary(ref: string) {
  const { rows } = await query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE d.state = 'merged')::int AS merged, count(*) FILTER (WHERE d.checks = 'failure')::int AS failing
     FROM dev_item_links l JOIN dev_items d ON d.id = l.dev_item_id WHERE l.record_ref = $1 AND d.item_type = 'pull_request'`,
    [ref.toUpperCase()],
  );
  return rows[0] as { total: number; merged: number; failing: number };
}

// ---- Sources (GitHub webhooks) ------------------------------------------------------------------------------------

export const sourceSchema = z.object({
  name: z.string().trim().min(2).max(100),
  // Only these repositories may link to Kernel records (a valid-looking delivery from another repository is refused).
  repositories: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).min(1).max(200),
  api_token: z.string().trim().max(500).optional(),
  enabled: z.boolean().default(true),
});

const webhookUrl = (id: number) => `${(config.publicUrl ?? '').replace(/\/$/, '')}/api/dev-hooks/${id}`;

export async function listSources(user: User) {
  authorize(user, 'change.manage');
  const { rows } = await query('SELECT id, name, platform, repositories, api_token IS NOT NULL AS has_token, enabled, received_count, rejected_count, last_received_at, created_at FROM dev_sources ORDER BY name');
  return rows.map((r) => ({ ...r, webhook_url: webhookUrl(r.id) }));
}

export async function createSource(user: User, input: z.infer<typeof sourceSchema>) {
  authorize(user, 'change.manage');
  const secret = randomBytes(24).toString('base64url');
  try {
    const { rows } = await query(
      'INSERT INTO dev_sources (name, webhook_secret, api_token, repositories, enabled, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [input.name, encryptSecret(secret), input.api_token ? encryptSecret(input.api_token) : null, input.repositories, input.enabled, user.id],
    );
    await audit(null, { entity_type: 'dev_source', entity_ref: `#${rows[0].id}`, action: 'create', changes: { name: input.name, repositories: input.repositories, has_token: !!input.api_token } });
    // The secret is shown once: GitHub needs it in the webhook settings.
    return { id: rows[0].id, webhook_url: webhookUrl(rows[0].id), webhook_secret: secret, content_type: 'application/json', events: ['pull_request', 'issues', 'push', 'workflow_run', 'check_suite', 'release'] };
  } catch (err: any) {
    if (err.code === '23505') throw new HttpError(409, 'A source with that name already exists');
    throw err;
  }
}

export async function updateSource(user: User, id: number, input: Partial<z.infer<typeof sourceSchema>>) {
  authorize(user, 'change.manage');
  const { rowCount } = await query(
    'UPDATE dev_sources SET repositories = coalesce($2, repositories), enabled = coalesce($3, enabled), api_token = CASE WHEN $4::text IS NULL THEN api_token WHEN $4 = \'\' THEN NULL ELSE $4 END WHERE id = $1',
    [id, input.repositories ?? null, input.enabled ?? null, input.api_token === undefined ? null : input.api_token === '' ? '' : encryptSecret(input.api_token)],
  );
  if (!rowCount) throw notFound('Source not found');
  await audit(null, { entity_type: 'dev_source', entity_ref: `#${id}`, action: 'update', changes: { repositories: input.repositories, enabled: input.enabled, token_changed: input.api_token !== undefined } });
  return (await listSources(user)).find((s) => s.id === id);
}

export async function rotateSourceSecret(user: User, id: number) {
  authorize(user, 'change.manage');
  const secret = randomBytes(24).toString('base64url');
  const { rowCount } = await query('UPDATE dev_sources SET webhook_secret = $2 WHERE id = $1', [id, encryptSecret(secret)]);
  if (!rowCount) throw notFound('Source not found');
  await audit(null, { entity_type: 'dev_source', entity_ref: `#${id}`, action: 'rotate_secret' });
  return { id, webhook_secret: secret };
}

export async function deleteSource(user: User, id: number) {
  authorize(user, 'change.manage');
  const { rowCount } = await query('DELETE FROM dev_sources WHERE id = $1', [id]);
  if (!rowCount) throw notFound('Source not found');
  await audit(null, { entity_type: 'dev_source', entity_ref: `#${id}`, action: 'delete' });
  return { ok: true };
}

/** GitHub signs each delivery: X-Hub-Signature-256 = sha256=HMAC(secret, raw body). */
export function verifyGitHubSignature(secret: string, raw: string, header: string | undefined) {
  if (!header?.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const HANDLED = new Set(['ping', 'pull_request', 'issues', 'push', 'workflow_run', 'check_suite', 'release']);

/**
 * One GitHub delivery. The signature is checked on the raw bytes before anything is parsed or stored; a replayed
 * delivery id and repositories outside the source's list are refused; only handled events are processed. Runs as
 * the integration (audited as such), which may see every record, but it never links to restricted ones.
 */
export async function receiveDevHook(req: FastifyRequest, sourceId: number, raw: string) {
  const { rows } = await asSystem(() => query('SELECT * FROM dev_sources WHERE id = $1', [sourceId]));
  const source = rows[0];
  const reject = async (err: Error) => {
    if (source) await asSystem(() => query('UPDATE dev_sources SET rejected_count = rejected_count + 1 WHERE id = $1', [source.id]));
    throw err;
  };
  if (!source || !verifyGitHubSignature(decryptSecret(source.webhook_secret), raw, req.headers['x-hub-signature-256'] as string | undefined)) {
    return reject(unauthorized('Unknown source or invalid signature'));
  }
  if (!source.enabled) return reject(forbidden('This source is disabled'));
  const event = String(req.headers['x-github-event'] ?? '');
  const delivery = String(req.headers['x-github-delivery'] ?? '').slice(0, 100);
  if (!delivery) return reject(badRequest('X-GitHub-Delivery is missing'));
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return reject(badRequest('The body is not JSON'));
  }
  const repo: string = body?.repository?.full_name ?? '';
  if (event !== 'ping' && !source.repositories.includes(repo)) return reject(forbidden(`Repository ${repo || '(none)'} is not configured for this source`));
  const ctx = { userId: null, userName: source.name, actorType: 'integration' as const, channel: 'github', tokenPrefix: '', ip: req.ip, userAgent: '', requestId: delivery, viewer: 'system' };
  return contextStore.run(ctx, async () => {
    const fresh = await query('INSERT INTO dev_deliveries (source_id, delivery_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [source.id, delivery]);
    await query('UPDATE dev_sources SET received_count = received_count + 1, last_received_at = now() WHERE id = $1', [source.id]);
    if (!fresh.rowCount) return { ok: true, event, ignored: 'replayed delivery' };
    if (!HANDLED.has(event)) return { ok: true, event, ignored: 'event not handled' };
    if (event === 'ping') return { ok: true, event };
    const linked = await tx((db) => handleEvent(db, event, body, repo, delivery));
    logger.info({ event: { dataset: 'kernel.dev' }, github_event: event, repo, linked }, 'dev platform event');
    return { ok: true, event, linked };
  });
}

/** Removes delivery ids older than a day (replays after that are harmless: links are idempotent). */
export async function pruneDeliveries() {
  await query("DELETE FROM dev_deliveries WHERE received_at < now() - interval '1 day'");
}

async function linkMentions(db: Db, itemId: number, text: string, also: string[] = [], delivery = '') {
  const linked: string[] = [];
  for (const ref of [...new Set([...refsIn(text), ...also])]) {
    const { rows } = await db.query('SELECT kind, is_restricted FROM kernel_record_lookup($1)', [ref]);
    // Restricted records are never linked from outside (and nothing tells the sender they exist, #53).
    if (!rows[0]?.kind || rows[0].is_restricted) continue;
    if (await linkItem(db, itemId, ref, 'webhook', null)) {
      linked.push(ref);
      await audit(db, { entity_type: rows[0].kind, entity_ref: ref, action: 'dev_link', changes: { dev_item_id: itemId, delivery } });
    }
  }
  return linked;
}

async function refsOfItems(db: Db, repo: string, type: ItemType, keys: string[]) {
  const { rows } = await db.query(
    'SELECT DISTINCT l.record_ref FROM dev_items d JOIN dev_item_links l ON l.dev_item_id = d.id WHERE d.repo = $1 AND d.item_type = $2 AND d.key = ANY($3)',
    [repo, type, keys],
  );
  return rows.map((r) => r.record_ref as string);
}

async function handleEvent(db: Db, event: string, b: any, repo: string, delivery: string): Promise<string[]> {
  const base = { platform: 'github' as const, repo };
  if (event === 'pull_request' && b.pull_request) {
    const p = b.pull_request;
    const id = await upsertItem(db, {
      ...base, item_type: 'pull_request', key: String(p.number), url: p.html_url, title: p.title,
      state: p.merged_at ? 'merged' : p.draft ? 'draft' : p.state, author: p.user?.login, data: { branch: p.head?.ref, base: p.base?.ref },
    });
    return linkMentions(db, id, `${p.title}\n${p.body ?? ''}\n${p.head?.ref ?? ''}`, [], delivery);
  }
  if (event === 'issues' && b.issue) {
    const i = b.issue;
    const id = await upsertItem(db, { ...base, item_type: 'issue', key: String(i.number), url: i.html_url, title: i.title, state: i.state, author: i.user?.login });
    return linkMentions(db, id, `${i.title}\n${i.body ?? ''}`, [], delivery);
  }
  if (event === 'push' && Array.isArray(b.commits)) {
    const linked: string[] = [];
    const branchRefs = refsIn(String(b.ref ?? ''));
    for (const c of b.commits.slice(0, 50)) {
      const refs = [...refsIn(String(c.message ?? '')), ...branchRefs];
      if (!refs.length) continue; // only commits that mention a Kernel record are kept
      const id = await upsertItem(db, { ...base, item_type: 'commit', key: String(c.id), url: c.url, title: String(c.message ?? '').split('\n')[0], state: 'committed', author: c.author?.username ?? c.author?.name });
      linked.push(...(await linkMentions(db, id, '', refs, delivery)));
    }
    return linked;
  }
  if (event === 'workflow_run' && b.workflow_run) {
    const r = b.workflow_run;
    const prNumbers = (r.pull_requests ?? []).map((p: any) => String(p.number));
    const id = await upsertItem(db, {
      ...base, item_type: 'workflow_run', key: String(r.id), url: r.html_url, title: `${r.name}: ${r.display_title ?? ''}`.trim(),
      state: r.conclusion ?? r.status, author: r.actor?.login, data: { branch: r.head_branch, sha: r.head_sha },
    });
    // A run belongs to the records its pull requests are linked to, and to refs in its title or branch.
    return linkMentions(db, id, `${r.display_title ?? ''}\n${r.head_branch ?? ''}`, await refsOfItems(db, repo, 'pull_request', prNumbers), delivery);
  }
  if (event === 'check_suite' && b.check_suite) {
    for (const p of b.check_suite.pull_requests ?? []) {
      await db.query("UPDATE dev_items SET checks = $3, updated_at = now() WHERE platform = 'github' AND repo = $1 AND item_type = 'pull_request' AND key = $2", [repo, String(p.number), b.check_suite.conclusion ?? b.check_suite.status]);
    }
    return [];
  }
  if (event === 'release' && b.release) {
    const r = b.release;
    const id = await upsertItem(db, { ...base, item_type: 'release', key: String(r.tag_name), url: r.html_url, title: r.name || r.tag_name, state: r.draft ? 'draft' : r.prerelease ? 'prerelease' : 'published', author: r.author?.login });
    return linkMentions(db, id, `${r.name ?? ''}\n${r.body ?? ''}`, [], delivery);
  }
  return [];
}
