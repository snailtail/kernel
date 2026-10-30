// Dev platform links (#32): where code fixes happen. A pasted GitHub, GitLab or Azure DevOps URL becomes a linked
// item with live status, and the platform's webhook keeps items current and links them when a PR, branch, commit or
// run mentions a Kernel ref ("Fixes CHG-17", "prb-42", "INC000012"). Each platform is an adapter (dev-platform.ts).
import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { User } from '../security/auth.js';
import { audit } from '../security/audit.js';
import { asIntegration, asSystem } from '../core/context.js';
import { type Db, query, tx } from '../core/db.js';
import { badRequest, forbidden, HttpError, notFound, unauthorized } from '../core/errors.js';
import { logger } from '../core/log.js';
import { validatePrivateAllow } from '../notifications/outbound.js';
import { authorize, type Action } from '../security/policy.js';
import { typeForRef } from '../records/records.js';
import { addEntry } from '../records/activity.js';
import { decryptSecret, encryptSecret } from '../security/secrets.js';
import { registerDeploymentChange } from '../changes/changes.js';
import { mirrorDelivered } from '../development/mirror.js';
import { azureDevOps, AZURE_DEVOPS } from './dev-azure.js';
import { github } from './dev-github.js';
import { gitlab, GITLAB_COM } from './dev-gitlab.js';
import { getJsonVia, iso, PLATFORMS, postJsonVia, refsIn, type Adapter, type CommitStatus, type EventContext, type ItemType, type ParsedItem, type Platform, type UpsertItem } from './dev-platform.js';
import { absoluteUrl } from '../core/url.js';

export type { ParsedItem } from './dev-platform.js';

const ADAPTERS: Record<Platform, Adapter> = { github, gitlab, azure_devops: azureDevOps };
const WRITE: Record<string, Action> = { problem: 'problem.link', change: 'change.update', incident: 'incident.update' };

/** A GitHub, GitLab or Azure DevOps URL as an item. `gitlabBases` are the self-hosted GitLabs of the sources. */
function parseDevUrl(raw: string, gitlabBases: string[] = []): ParsedItem {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw badRequest('Paste the link to a pull request, issue, commit, workflow run or release');
  }
  if (u.protocol !== 'https:') throw badRequest('Only https links are supported');
  for (const adapter of Object.values(ADAPTERS)) {
    const item = adapter.parseUrl(u, gitlabBases);
    if (item) return item;
  }
  throw badRequest('Paste a link from GitHub, GitLab or Azure DevOps');
}

async function upsertItem(db: Db, item: UpsertItem) {
  // Links are shown as links: a delivery's URL that is not https (javascript:, data:…) is not kept.
  const url = /^https:\/\//i.test(String(item.url ?? '')) ? item.url : '';
  const { rows } = await db.query(
    `INSERT INTO dev_items (platform, repo, item_type, key, url, title, state, checks, author, environment, data)
     VALUES ($1, $2, $3, $4, $5, coalesce($6, ''), coalesce($7, 'unknown'), $8, coalesce($9, ''), coalesce($10, ''), coalesce($11::jsonb, '{}'))
     ON CONFLICT (platform, repo, item_type, key) DO UPDATE SET
       title = coalesce(nullif($6, ''), dev_items.title), state = coalesce($7, dev_items.state), checks = coalesce($8, dev_items.checks),
       author = coalesce(nullif($9, ''), dev_items.author), environment = coalesce(nullif($10, ''), dev_items.environment),
       data = dev_items.data || coalesce($11::jsonb, '{}'), updated_at = now()
     RETURNING id`,
    [item.platform, item.repo, item.item_type, item.key, url, item.title ?? null, item.state ?? null, item.checks ?? null, item.author ?? null, item.environment ?? null, item.data ? JSON.stringify(item.data) : null],
  );
  return rows[0].id as number;
}

async function linkItem(db: Db, itemId: number, ref: string, via: 'manual' | 'webhook' | 'mcp', userId: number | null) {
  const t = typeForRef(ref);
  if (!WRITE[t.type]) throw badRequest('Dev links belong on problems, changes and incidents');
  const type = t.type;
  const { rows: rec } = await db.query(`SELECT id FROM ${t.table} WHERE ref = $1`, [ref]);
  if (!rec[0]) throw notFound(`${ref} not found`);
  const { rowCount } = await db.query('INSERT INTO dev_item_links (dev_item_id, record_type, record_ref, linked_by, via) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [itemId, type, ref, userId, via]);
  if (!rowCount) return false;
  const { rows: item } = await db.query('SELECT platform, repo, item_type, key, title FROM dev_items WHERE id = $1', [itemId]);
  const i = item[0];
  await addEntry(db, type, rec[0].id, {
    userId, kind: 'link', body: `Linked ${label(i)}${via === 'webhook' ? ` (mentioned on ${ADAPTERS[i.platform as Platform]?.label ?? i.platform})` : ''}`, data: { kind: 'dev_item', dev_item_id: itemId, action: 'add' },
  });
  return true;
}

const label = (i: { repo: string; item_type: string; key: string }) =>
  `${{ pull_request: 'PR', issue: 'issue', commit: 'commit', workflow_run: 'run', release: 'release', deployment: 'deploy' }[i.item_type] ?? i.item_type} ${i.repo}${i.item_type === 'commit' ? `@${i.key.slice(0, 7)}` : i.item_type === 'release' ? ` ${i.key}` : `#${i.key}`}`;

/** The source that accepts this repository on this platform and host, preferring one with a token. */
async function sourceFor(platform: Platform, base: string, repo: string) {
  const { rows } = await query(
    `SELECT id, api_token, private_allow, ca_pem FROM dev_sources
     WHERE enabled AND platform = $1 AND base_url = $2 AND EXISTS (SELECT 1 FROM unnest(repositories) r WHERE lower(r) = lower($3))
     ORDER BY api_token IS NULL, id LIMIT 1`,
    [platform, base, repo],
  );
  return rows[0] as { id: number; api_token: string | null; private_allow: string[]; ca_pem: string | null } | undefined;
}

/**
 * Title and status from the platform's API (best effort: public repositories, or with the token of a source that
 * accepts the repository), through that source's network settings.
 */
async function fetchStatus(item: ParsedItem, s: Awaited<ReturnType<typeof sourceFor>>) {
  if (process.env.KERNEL_DEV_STATUS_FETCH === 'false') return {}; // tests and air-gapped installations
  const get = getJsonVia(s?.private_allow ?? [], s?.ca_pem ?? null);
  try {
    return await ADAPTERS[item.platform].fetchStatus(item, s?.api_token ? decryptSecret(s.api_token) : null, get);
  } catch {
    return {};
  }
}

/** The self-hosted GitLabs that sources are configured for, so their links are recognised. */
async function gitlabBases() {
  const { rows } = await query("SELECT DISTINCT base_url FROM dev_sources WHERE enabled AND platform = 'gitlab' AND base_url <> $1", [GITLAB_COM]);
  return rows.map((r) => r.base_url as string);
}

// ---- Links from Kernel ------------------------------------------------------------------------------------------

export async function addDevLink(user: User, ref: string, url: string, via: 'manual' | 'mcp' = 'manual') {
  const t = typeForRef(ref);
  if (!WRITE[t.type]) throw badRequest('Dev links belong on problems, changes and incidents');
  authorize(user, WRITE[t.type]);
  await t.get(user, ref.toUpperCase()); // visible to the caller (404 otherwise)
  const parsed = parseDevUrl(url, await gitlabBases());
  const source = await sourceFor(parsed.platform, parsed.base, parsed.repo);
  const status = await fetchStatus(parsed, source);
  const id = await tx(async (db) => {
    // The source is remembered, so the change status can be posted back with its token (if it opted in).
    const itemId = await upsertItem(db, { ...parsed, ...status, data: { ...parsed.data, ...status.data, ...(source ? { source_id: source.id } : {}) } });
    await linkItem(db, itemId, ref.toUpperCase(), via, user.id);
    return itemId;
  });
  if (t.type === 'change') await postStatusForItems([id]);
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

// ---- Sources (webhooks) ------------------------------------------------------------------------------------------

const BASES: Record<Platform, string> = { github: 'https://github.com', gitlab: GITLAB_COM, azure_devops: AZURE_DEVOPS };

export const sourceSchema = z.object({
  name: z.string().trim().min(2).max(100),
  platform: z.enum(PLATFORMS).default('github'),
  // GitLab only: a self-hosted GitLab (https, no query); gitlab.com when left out.
  base_url: z.string().trim().max(300).regex(/^https:\/\/[^\s?#]+$/, 'An https address without query').optional(),
  // Only these repositories (owner/repo, group/project or organisation/project) may link to Kernel records; a
  // valid-looking delivery from anywhere else is refused.
  repositories: z.array(z.string().trim().min(3).max(200)).min(1).max(200),
  api_token: z.string().trim().max(500).optional(),
  // A self-hosted GitLab on the private network: the private ranges it is on, and the CA that signed its certificate.
  private_allow: z.array(z.string().max(100)).max(20).optional(),
  ca_pem: z.string().max(20_000).nullable().optional(),
  // Status back on pull requests (opt-in): a separate token that may only write commit statuses.
  status_token: z.string().trim().max(500).optional(),
  post_status: z.boolean().optional(),
  enabled: z.boolean().default(true),
});
type SourceInput = z.infer<typeof sourceSchema>;

function checkSource(platform: Platform, input: Partial<SourceInput>) {
  const adapter = ADAPTERS[platform];
  const bad = input.repositories?.find((r) => !adapter.scopePattern.test(r));
  if (bad) throw badRequest(`${bad} is not a ${adapter.label} ${adapter.scopeExample}`);
  if (input.private_allow?.length) {
    const problem = validatePrivateAllow(input.private_allow);
    if (problem) throw badRequest(problem);
  }
  if (input.ca_pem && !/-----BEGIN CERTIFICATE-----/.test(input.ca_pem)) throw badRequest('The CA certificate must be PEM');
}

const webhookUrl = (id: number) => absoluteUrl(`/api/dev-hooks/${id}`);

export async function listSources(user: User) {
  authorize(user, 'change.manage');
  const { rows } = await query(
    `SELECT id, name, platform, base_url, repositories, api_token IS NOT NULL AS has_token, private_allow, ca_pem IS NOT NULL AS has_ca,
            status_token IS NOT NULL AS has_status_token, post_status, enabled,
            received_count, rejected_count, last_received_at, created_at FROM dev_sources ORDER BY name`,
  );
  return rows.map((r) => ({ ...r, webhook_url: webhookUrl(r.id) }));
}

export async function createSource(user: User, input: SourceInput) {
  authorize(user, 'change.manage');
  checkSource(input.platform, input);
  if (input.base_url && input.platform !== 'gitlab') throw badRequest('Only a GitLab source has its own address');
  const baseUrl = input.platform === 'gitlab' && input.base_url ? input.base_url.replace(/\/+$/, '') : BASES[input.platform];
  const secret = randomBytes(24).toString('base64url');
  try {
    const { rows } = await query(
      `INSERT INTO dev_sources (name, platform, base_url, webhook_secret, api_token, repositories, private_allow, ca_pem, status_token, post_status, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [input.name, input.platform, baseUrl, encryptSecret(secret), input.api_token ? encryptSecret(input.api_token) : null, input.repositories, input.private_allow ?? [], input.ca_pem || null,
        input.status_token ? encryptSecret(input.status_token) : null, !!input.post_status && !!input.status_token, input.enabled, user.id],
    );
    await audit(null, { entity_type: 'dev_source', entity_ref: `#${rows[0].id}`, action: 'create', changes: { name: input.name, platform: input.platform, base_url: baseUrl, repositories: input.repositories, has_token: !!input.api_token } });
    // The secret is shown once: the platform needs it in its webhook settings.
    return { id: rows[0].id, platform: input.platform, webhook_url: webhookUrl(rows[0].id), webhook_secret: secret, content_type: 'application/json', events: ADAPTERS[input.platform].events };
  } catch (err: any) {
    if (err.code === '23505') throw new HttpError(409, 'A source with that name already exists');
    throw err;
  }
}

export async function updateSource(user: User, id: number, input: Partial<SourceInput>) {
  authorize(user, 'change.manage');
  const { rows } = await query('SELECT platform FROM dev_sources WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Source not found');
  checkSource(rows[0].platform, input);
  await query(
    `UPDATE dev_sources SET repositories = coalesce($2, repositories), enabled = coalesce($3, enabled),
       api_token = CASE WHEN $4::text IS NULL THEN api_token WHEN $4 = '' THEN NULL ELSE $4 END,
       private_allow = coalesce($5, private_allow), ca_pem = CASE WHEN $6::boolean THEN nullif($7, '') ELSE ca_pem END,
       status_token = CASE WHEN $8::text IS NULL THEN status_token WHEN $8 = '' THEN NULL ELSE $8 END, post_status = coalesce($9, post_status) WHERE id = $1`,
    [id, input.repositories ?? null, input.enabled ?? null, input.api_token === undefined ? null : input.api_token === '' ? '' : encryptSecret(input.api_token),
      input.private_allow ?? null, input.ca_pem !== undefined, input.ca_pem ?? null,
      input.status_token === undefined ? null : input.status_token === '' ? '' : encryptSecret(input.status_token), input.post_status ?? null],
  );
  // Posting needs the status token: without one, the opt-in stays off.
  await query('UPDATE dev_sources SET post_status = false WHERE id = $1 AND status_token IS NULL', [id]);
  await audit(null, { entity_type: 'dev_source', entity_ref: `#${id}`, action: 'update', changes: { repositories: input.repositories, enabled: input.enabled, token_changed: input.api_token !== undefined, private_allow: input.private_allow, ca_changed: input.ca_pem !== undefined, status_token_changed: input.status_token !== undefined, post_status: input.post_status } });
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

// ---- Deployment targets ------------------------------------------------------------------------------------------

export const targetSchema = z.object({
  repo: z.string().trim().min(3).max(200),
  environment: z.string().trim().min(1).max(100),
  // The CIs and services a deploy to this environment changes (refs such as SVC000003 or CI000012).
  cis: z.array(z.string().trim().min(3).max(30)).max(50).default([]),
  production: z.boolean().default(false),
  // Off unless an admin turns it on: a successful deploy then registers a standard change from this template.
  register_change: z.boolean().default(false),
  template_id: z.number().int().nullable().optional(),
});

export async function listTargets(user: User, sourceId: number) {
  authorize(user, 'change.manage');
  const { rows } = await query(
    `SELECT t.id, t.repo, t.environment, t.ci_refs AS cis, t.production, t.register_change, t.template_id, ct.name AS template_name, t.created_at
     FROM dev_deploy_targets t LEFT JOIN change_templates ct ON ct.id = t.template_id WHERE t.source_id = $1 ORDER BY t.repo, t.environment`,
    [sourceId],
  );
  return rows;
}

export async function createTarget(user: User, sourceId: number, input: z.infer<typeof targetSchema>) {
  authorize(user, 'change.manage');
  const { rows: src } = await query('SELECT platform, repositories FROM dev_sources WHERE id = $1', [sourceId]);
  if (!src[0]) throw notFound('Source not found');
  const adapter = ADAPTERS[src[0].platform as Platform];
  if (!adapter.inScope(src[0].repositories, input.repo)) throw badRequest(`${input.repo} is not one of this source's ${adapter.scopeExample} entries`);
  const cis = [...new Set(input.cis.map((c) => c.toUpperCase()))];
  const { rows: found } = await query('SELECT ref FROM configuration_items WHERE ref = ANY($1)', [cis]);
  const missing = cis.filter((c) => !found.some((f) => f.ref === c));
  if (missing.length) throw badRequest(`Unknown CI or service: ${missing.join(', ')}`);
  if (input.register_change) {
    if (!input.production) throw badRequest('Only a production target registers changes');
    if (!input.template_id) throw badRequest('Choose the standard change template a deploy registers');
    if (!cis.length) throw badRequest('A standard change must name the CIs it changes');
    const { rows: t } = await query('SELECT 1 FROM change_templates WHERE id = $1 AND active', [input.template_id]);
    if (!t[0]) throw badRequest('Unknown or inactive standard change template');
  }
  try {
    const { rows } = await query(
      `INSERT INTO dev_deploy_targets (source_id, repo, environment, ci_refs, production, register_change, template_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [sourceId, input.repo, input.environment, cis, input.production, input.register_change, input.register_change ? input.template_id : null, user.id],
    );
    await audit(null, { entity_type: 'dev_source', entity_ref: `#${sourceId}`, action: 'deploy_target_create', changes: { target: rows[0].id, ...input, cis } });
    return (await listTargets(user, sourceId)).find((t) => t.id === rows[0].id);
  } catch (err: any) {
    if (err.code === '23505') throw new HttpError(409, 'That repository and environment are already mapped');
    throw err;
  }
}

export async function deleteTarget(user: User, id: number) {
  authorize(user, 'change.manage');
  const { rows } = await query('DELETE FROM dev_deploy_targets WHERE id = $1 RETURNING source_id', [id]);
  if (!rows[0]) throw notFound('Deployment target not found');
  await audit(null, { entity_type: 'dev_source', entity_ref: `#${rows[0].source_id}`, action: 'deploy_target_delete', changes: { target: id } });
  return { ok: true };
}

/** Plain HTTP is accepted for Basic-auth deliveries only when explicitly allowed (local development and tests). */
const insecureHooksAllowed = () => process.env.KERNEL_DEV_HOOKS_ALLOW_HTTP === 'true';

/**
 * One delivery. The credentials are checked on the raw request before anything is parsed or stored; a replayed
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
  const adapter: Adapter | undefined = source && ADAPTERS[source.platform as Platform];
  // The secret travels in the request itself (Basic auth): over plain HTTP it is refused before it is even compared.
  if (adapter?.httpsOnly && req.protocol !== 'https' && !insecureHooksAllowed()) {
    return reject(forbidden(`${adapter.label} deliveries must arrive over HTTPS. Kernel sees this request as http: behind a proxy or tunnel that terminates TLS, set KERNEL_TRUST_PROXY so Kernel trusts its X-Forwarded-Proto`));
  }
  if (!source || !adapter || !adapter.verify(req, raw, decryptSecret(source.webhook_secret))) {
    return reject(unauthorized('Unknown source or invalid signature'));
  }
  if (!source.enabled) return reject(forbidden('This source is disabled'));
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return reject(badRequest('The body is not JSON'));
  }
  const d = adapter.read(req, body);
  if (!d) return reject(badRequest('The delivery id is missing'));
  const { event, delivery, scope } = d;
  if (!d.ping && !adapter.inScope(source.repositories, scope)) return reject(forbidden(`Repository ${scope || '(none)'} is not configured for this source`));
  return asIntegration({ name: source.name, channel: source.platform, requestId: delivery, ip: req.ip }, async () => {
    const fresh = await query('INSERT INTO dev_deliveries (source_id, delivery_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [source.id, delivery]);
    await query('UPDATE dev_sources SET received_count = received_count + 1, last_received_at = now() WHERE id = $1', [source.id]);
    if (!fresh.rowCount) return { ok: true, event, ignored: 'replayed delivery' };
    if (d.ping) return { ok: true, event };
    if (event.startsWith('unhandled:')) return { ok: true, event: event.slice(10), ignored: 'event not handled' };
    const after: (() => Promise<void>)[] = [];
    const touched = new Set<number>();
    const linked = await tx((db) => adapter.handle(eventContext(db, source, scope, delivery, after, touched), event, body, scope));
    // Once the delivery is committed: changes registered by production deploys, then the status on pull requests.
    for (const job of after) await job();
    if (touched.size) await postStatusForItems([...touched]);
    logger.info({ event: { dataset: 'kernel.dev' }, dev_platform: source.platform, dev_event: event, repo: scope, linked }, 'dev platform event');
    return { ok: true, event, linked };
  });
}

/** Removes delivery ids older than a day (replays after that are harmless: links are idempotent). */
export async function pruneDeliveries() {
  await query("DELETE FROM dev_deliveries WHERE received_at < now() - interval '1 day'");
}

function eventContext(db: Db, source: { id: number; platform: Platform }, scope: string, delivery: string, after: (() => Promise<void>)[], touched: Set<number>): EventContext {
  const platform = source.platform;
  const upsert = async (item: UpsertItem) => {
    const id = await upsertItem(db, { ...item, data: { ...item.data, source_id: source.id } });
    if (item.item_type === 'pull_request') touched.add(id);
    return id;
  };
  const ctx: EventContext = {
    upsert,
    async mention(itemId, text, also = []) {
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
    },
    async refsOf(repo, type: ItemType, keys) {
      if (!keys.length) return [];
      const { rows } = await db.query(
        'SELECT DISTINCT l.record_ref FROM dev_items d JOIN dev_item_links l ON l.dev_item_id = d.id WHERE d.platform = $1 AND d.repo = $2 AND d.item_type = $3 AND d.key = ANY($4)',
        [platform, repo, type, keys],
      );
      return rows.map((r) => r.record_ref as string);
    },
    async setChecks(repo, prKey, checks) {
      await db.query("UPDATE dev_items SET checks = $4, updated_at = now() WHERE platform = $1 AND repo = $2 AND item_type = 'pull_request' AND key = $3", [platform, repo, prKey, checks]);
    },
    mirrored: (item) => mirrorDelivered(db, source.id, scope, item),
    async deployed(d) {
      const { rows: targets } = await db.query(
        'SELECT * FROM dev_deploy_targets WHERE source_id = $1 AND lower(repo) = lower($2) AND lower(environment) = lower($3)',
        [source.id, d.repo, d.environment],
      );
      const target = targets[0];
      // Without a mapping, an environment called prod or production still counts as production for the suggestions.
      const production = target ? target.production : /^prod(uction)?$/i.test(d.environment);
      const id = await upsertItem(db, {
        platform, repo: d.repo, item_type: 'deployment', key: d.key, url: d.url, title: d.title, state: d.state, author: d.author, environment: d.environment,
        data: { source_id: source.id, sha: d.sha, production, rollback: !!d.rollback, target_id: target?.id, cis: target?.ci_refs, started_at: iso(d.started_at), finished_at: iso(d.finished_at) },
      });
      // What the deploy contains: items at its commit, and pull requests merged since the last successful deploy there
      // (by when they were merged; a PR from before merged_at was kept falls back to its last update).
      const { rows: contents } = await db.query(
        `SELECT id, repo, item_type, key FROM dev_items i WHERE platform = $1 AND repo = $2 AND item_type IN ('pull_request', 'commit', 'workflow_run')
           AND (($3::text IS NOT NULL AND (key = $3 OR data->>'sha' = $3 OR data->>'merge_sha' = $3))
             OR (item_type = 'pull_request' AND state = 'merged' AND coalesce((data->>'merged_at')::timestamptz, updated_at) > coalesce(
                  (SELECT max(coalesce((p.data->>'finished_at')::timestamptz, p.updated_at)) FROM dev_items p WHERE p.platform = $1 AND p.repo = $2
                     AND p.item_type = 'deployment' AND lower(p.environment) = lower($4) AND p.state = 'success' AND p.id <> $5), now() - interval '7 days')))`,
        [platform, d.repo, d.sha ?? null, d.environment, id],
      );
      const { rows: refs } = await db.query('SELECT DISTINCT record_ref FROM dev_item_links WHERE dev_item_id = ANY($1)', [contents.map((c) => c.id)]);
      const linked = await ctx.mention(id, d.text ?? '', refs.map((r) => r.record_ref as string));
      if (d.state === 'success' && target?.register_change && target.template_id) {
        after.push(() => registerFromDeploy(source.id, { ...d, started_at: iso(d.started_at), finished_at: iso(d.finished_at), id, platform, target_id: target.id, authorised_by: target.created_by, template_id: target.template_id, cis: target.ci_refs, contents }));
      }
      return linked;
    },
  };
  return ctx;
}

/**
 * A successful production deploy, on a target where an admin turned it on, registers a standard change: the target's
 * template and CIs, the deploy's times, and the pull requests, commits and runs it contained. Once per deployment. A
 * deploy outside the template's scope (risk, CI types, a change freeze) registers nothing; the reason is kept on the
 * deployment and audited, so someone can raise a normal change instead.
 */
async function registerFromDeploy(sourceId: number, d: Parameters<EventContext['deployed']>[0] & { id: number; platform: Platform; target_id: number; authorised_by: number | null; template_id: number; cis: string[]; contents: { id: number; repo: string; item_type: string; key: string }[] }) {
  const now = new Date().toISOString();
  const contained = d.contents.map(label);
  try {
    const r = await registerDeploymentChange({
      template_id: d.template_id, title: `Deploy ${d.repo} to ${d.environment}${d.sha ? ` (${d.sha.slice(0, 7)})` : ''}`,
      description: `Registered by a successful deploy on ${ADAPTERS[d.platform].label}.${contained.length ? `\n\nContains: ${contained.slice(0, 30).join(', ')}.` : ''}`,
      cis: d.cis, actual_start: d.started_at ?? d.finished_at ?? now, actual_end: d.finished_at ?? now, source_key: `${d.platform}:${d.repo}:${d.key}`.slice(0, 300), target_id: d.target_id, authorised_by: d.authorised_by,
    });
    await tx(async (db) => {
      if (r.created) for (const itemId of [d.id, ...d.contents.map((c) => c.id)]) await linkItem(db, itemId, r.ref, 'webhook', null);
      await db.query("UPDATE dev_items SET data = data || jsonb_build_object('change_ref', $2::text) - 'change_error' WHERE id = $1", [d.id, r.ref]);
    });
  } catch (err) {
    const reason = (err as Error).message.slice(0, 500);
    await query("UPDATE dev_items SET data = data || jsonb_build_object('change_error', $2::text) WHERE id = $1", [d.id, reason]);
    await audit(null, { entity_type: 'dev_source', entity_ref: `#${sourceId}`, action: 'deploy_change_refused', changes: { deployment: d.key, repo: d.repo, environment: d.environment, reason } });
    logger.warn({ event: { dataset: 'kernel.dev' }, deployment: d.key, reason }, 'deploy did not register a standard change');
  }
}

// ---- Status back on pull requests -------------------------------------------------------------------------------

const hhmm = (d: Date) => d.toISOString().slice(11, 16);
const day = (d: Date) => d.toISOString().slice(0, 10);
function windowText(start: Date | null, end: Date | null) {
  if (!start || !end) return '';
  return day(start) === day(end) ? `${day(start)} ${hhmm(start)}–${hhmm(end)} UTC` : `${day(start)} ${hhmm(start)} – ${day(end)} ${hhmm(end)} UTC`;
}

/** What one change says to a pull request about to be merged or deployed. */
export function changeStatus(c: { ref: string; status: string; change_type: string; planned_start: Date | null; planned_end: Date | null }, now = new Date()): Omit<CommitStatus, 'target_url'> {
  if (c.status === 'rejected' || c.status === 'cancelled') return { state: 'failure', description: `${c.ref} was ${c.status}` };
  if (c.status === 'closed') return { state: 'success', description: `${c.ref} implemented` };
  const authorised = ['scheduled', 'implementing', 'review'].includes(c.status) || (c.change_type === 'standard' && c.status !== 'draft');
  if (!authorised) return { state: 'pending', description: `${c.ref} not yet authorised` };
  const w = windowText(c.planned_start, c.planned_end);
  if (!w) return { state: 'success', description: `${c.ref} authorised` };
  const inWindow = now >= new Date(c.planned_start!) && now <= new Date(c.planned_end!);
  return inWindow ? { state: 'success', description: `${c.ref} authorised, window ${w}` } : { state: 'pending', description: `${c.ref} authorised, outside the window ${w}` };
}

const RANK = { failure: 2, pending: 1, success: 0 } as const;

/**
 * Posts the change status on these pull requests, for sources that opted in with a status token. A PR linked to
 * several changes gets the least ready of them. Restricted changes are left out: the platform is told nothing about
 * them. Best effort: the outcome is kept on the item (kernel_status), and a failure never blocks Kernel.
 */
async function postStatusForItems(ids: number[]) {
  if (!ids.length) return;
  await asSystem(async () => {
    const { rows } = await query(
      `SELECT d.id, d.platform, d.repo, d.key, d.data, s.base_url, s.status_token, s.private_allow, s.ca_pem
       FROM dev_items d JOIN dev_sources s ON s.id = (d.data->>'source_id')::int
       WHERE d.id = ANY($1) AND d.item_type = 'pull_request' AND s.enabled AND s.post_status AND s.status_token IS NOT NULL`,
      [ids],
    );
    // A few at a time, and the whole round within a limit: a slow platform never holds up a change for long.
    const queue = [...rows];
    const worker = async () => {
      for (let pr = queue.shift(); pr; pr = queue.shift()) await postOne(pr);
    };
    const postOne = async (pr: any) => {
      const { rows: changes } = await query(
        `SELECT c.ref, c.status, c.change_type, c.planned_start, c.planned_end FROM dev_item_links l JOIN changes c ON c.ref = l.record_ref
         WHERE l.dev_item_id = $1 AND l.record_type = 'change' AND NOT coalesce((SELECT is_restricted FROM kernel_record_lookup(c.ref)), false) ORDER BY c.ref`,
        [pr.id],
      );
      if (!changes.length) return;
      const each = changes.map((c) => ({ ...changeStatus(c), ref: c.ref as string }));
      const worst = each.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a));
      const status: CommitStatus = { state: worst.state, description: (each.length > 1 ? `${worst.description} (+${each.length - 1} more)` : worst.description).slice(0, 140), target_url: changeLink(worst.ref) };
      const ok = await ADAPTERS[pr.platform as Platform].postStatus(pr, pr.base_url, decryptSecret(pr.status_token), postJsonVia(pr.private_allow, pr.ca_pem), status).catch(() => false);
      await query("UPDATE dev_items SET data = data || jsonb_build_object('kernel_status', $2::jsonb) WHERE id = $1", [pr.id, JSON.stringify({ state: status.state, description: status.description, ok, at: new Date().toISOString() })]);
    };
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, STATUS_ROUND_MS); });
    await Promise.race([Promise.all(Array.from({ length: Math.min(STATUS_PARALLEL, rows.length) }, worker)), limit]);
    clearTimeout(timer);
    queue.length = 0; // past the limit, the rest waits for the next event or window refresh
  });
}

const STATUS_PARALLEL = 4;
const STATUS_ROUND_MS = 15_000;

/** After a change moved or its window changed: the status on every pull request linked to it. */
export async function postChangeStatus(ref: string) {
  const { rows } = await asSystem(() => query("SELECT dev_item_id FROM dev_item_links WHERE record_type = 'change' AND record_ref = $1", [ref.toUpperCase()]));
  await postStatusForItems(rows.map((r) => r.dev_item_id as number));
}

/** A window opening or closing changes the status without anything else happening: posted again every few minutes. */
export async function refreshWindowStatuses(minutes = 6) {
  const { rows } = await asSystem(() => query(
    `SELECT DISTINCT l.dev_item_id FROM changes c JOIN dev_item_links l ON l.record_type = 'change' AND l.record_ref = c.ref
     WHERE c.status IN ('scheduled', 'implementing') AND (c.planned_start BETWEEN now() - $1 * interval '1 minute' AND now() OR c.planned_end BETWEEN now() - $1 * interval '1 minute' AND now())`,
    [minutes],
  ));
  await postStatusForItems(rows.map((r) => r.dev_item_id as number));
}

const changeLink = (ref: string) => absoluteUrl(`/changes/${ref}`);

/** For change guidance: the latest deployment per environment among the change's links. */
export async function deploymentSummary(ref: string) {
  const { rows } = await query(
    `SELECT DISTINCT ON (lower(d.environment)) d.environment, d.state, coalesce((d.data->>'production')::boolean, false) AS production, coalesce((d.data->>'rollback')::boolean, false) AS rollback
     FROM dev_item_links l JOIN dev_items d ON d.id = l.dev_item_id WHERE l.record_ref = $1 AND d.item_type = 'deployment' AND d.state IN ('success', 'failure')
     ORDER BY lower(d.environment), d.updated_at DESC`,
    [ref.toUpperCase()],
  );
  return rows as { environment: string; state: string; production: boolean; rollback: boolean }[];
}
