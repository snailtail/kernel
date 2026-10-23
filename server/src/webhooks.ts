// Outbound webhooks. Events are queued in webhook_deliveries inside the same transaction as the change that caused
// them (outbox pattern) and sent by a background worker with HMAC signatures and retries.
import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { query, tx } from './db.js';
import { badRequest, notFound } from './errors.js';
import { audit } from './audit.js';
import { minimiseData } from './minimise.js';
import { checkUrl, outboundFetch } from './outbound.js';
import { decryptSecret, encryptSecret, isEncrypted, secretsConfigured } from './secrets.js';
import { absoluteUrl } from './core/url.js';
import { GiveUp, processOutbox } from './core/outbox.js';
import { provided } from './core/hooks.js';

/** A request task's payload as it is sent (requests.ts adds its callback), or null when the task is no longer open. */
export const requestTaskPayload = provided<[payload: any], any>((payload) => payload);

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

export const EVENTS = [
  'problem.created',
  'problem.status_changed',
  'problem.assigned',
  'problem.updated',
  'problem.commented',
  'problem.linked',
  'problem.assessed',
  'problem.analysis',
  'action.changed',
  'action.overdue',
  // A published status update (#46): only to webhooks that choose it ("all events" means the problem events above),
  // with the published text under public names (status-subscriptions.ts queueOutside).
  'status.published',
  // A service request's webhook task (#44): only to the webhook a catalogue item names for that task, with a callback.
  'request.task',
  // An automation rule's webhook action (#49): only to the webhook the rule names.
  'rule.matched',
] as const;
export type EventType = (typeof EVENTS)[number];
export const FORMATS = ['json', 'slack', 'teams_workflow', 'teams'] as const;

const MAX_ATTEMPTS = 6;

/** Maps an activity log entry to a webhook event type. */
export function eventFor(kind: string, data: any): EventType {
  switch (kind) {
    case 'created': return 'problem.created';
    case 'status': return 'problem.status_changed';
    case 'update': return data && 'assignee_id' in data ? 'problem.assigned' : 'problem.updated';
    case 'comment': return 'problem.commented';
    case 'link': return 'problem.linked';
    case 'assessment': return 'problem.assessed';
    case 'analysis': return 'problem.analysis';
    default: return 'action.changed';
  }
}

const problemUrl = (ref: string) => (config.publicUrl ? absoluteUrl(`/problems/${ref}`) : null);

const SUMMARY_MAX = 200;
const summaryFor = (event: EventType, summary: string) =>
  event === 'problem.commented' ? 'Added a work note' : summary.length > SUMMARY_MAX ? summary.slice(0, SUMMARY_MAX - 1) + '…' : summary;

/** Queues deliveries for all active webhooks subscribed to the event. Call inside the change's transaction. */
export async function enqueue(db: Db, event: EventType, problemId: number, actorId: number | null, summary: string, data: object) {
  const { rows: hooks } = await db.query(
    `SELECT id FROM webhooks WHERE active AND (cardinality(events) = 0 OR $1 = ANY(events))`,
    [event],
  );
  if (!hooks.length) return;
  const { rows } = await db.query(
    `SELECT p.ref, p.title, p.status, p.priority, p.is_major, p.restricted, p.classification, a.username AS assignee,
            u.username AS actor_username, u.display_name AS actor_name
     FROM problems p LEFT JOIN users a ON a.id = p.assignee_id LEFT JOIN users u ON u.id = $2 WHERE p.id = $1`,
    [problemId, actorId],
  );
  const p = rows[0];
  if (!p) return;
  // A restricted problem leaves Kernel only as its ref (#53): receivers learn that something changed, not what.
  const payload = p.restricted
    ? { event, occurred_at: new Date().toISOString(), problem: { ref: p.ref, restricted: true, url: problemUrl(p.ref) }, actor: null, summary: 'A restricted problem changed.', data: {} }
    : {
    event,
    occurred_at: new Date().toISOString(),
    problem: { ref: p.ref, title: p.title, status: p.status, priority: p.priority, is_major: p.is_major, assignee: p.assignee, url: problemUrl(p.ref) },
    actor: p.actor_username ? { username: p.actor_username, display_name: p.actor_name } : null,
    // A confidential problem's title stays readable (#61), but what changed may quote its text.
    summary: p.classification === 'confidential' ? 'A confidential problem changed.' : summaryFor(event, summary),
    data: p.classification === 'confidential' ? {} : minimiseData(data),
  };
  for (const h of hooks) {
    await db.query('INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1, $2, $3)', [h.id, event, JSON.stringify(payload)]);
  }
}

/**
 * Queues one delivery to one named webhook (a request task, a rule's action) if it is still active, in the caller's
 * transaction; the worker signs and sends it like every other delivery. Returns whether it was queued.
 */
export async function enqueueTo(db: Db, webhookId: number, event: EventType, payload: object) {
  const { rowCount } = await db.query(
    'INSERT INTO webhook_deliveries (webhook_id, event, payload) SELECT id, $2, $3 FROM webhooks WHERE id = $1 AND active',
    [webhookId, event, JSON.stringify(payload)],
  );
  return !!rowCount;
}

/** Formats the payload for the webhook's target (generic JSON, Slack or Teams incoming webhooks). */
export function formatBody(format: string, payload: any) {
  if (format === 'json') return payload;
  // A published status update (#46) links to the public page and speaks for itself.
  const status = payload.status_update;
  const p = payload.problem ?? (status ? { url: payload.url } : {});
  const who = payload.actor?.display_name ?? 'Kernel';
  const title = p.ref ? `${p.ref}: ${p.title}` : status ? `${payload.title}: ${status.services.join(', ')}` : 'Kernel';
  const line = status ? payload.summary : `${who}: ${payload.summary || payload.event}`;
  const open = status ? 'Status page' : 'Open in Kernel';
  // Optional link buttons, e.g. Approve and Reject on a personal approval notice (#48).
  const actions: { title: string; url: string }[] = payload.actions ?? [];
  if (format === 'slack') {
    const link = p.url ? `<${p.url}|${title}>` : `*${title}*`;
    const buttons = actions.map((a) => `<${a.url}|${a.title}>`).join(' · ');
    return { text: `${link}\n${line}${buttons ? `\n${buttons}` : ''}` };
  }
  if (format === 'teams_workflow') {
    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
              { type: 'TextBlock', text: line, wrap: true },
            ],
            ...(p.url || actions.length ? { actions: [...actions, ...(p.url ? [{ title: open, url: p.url }] : [])].map((a) => ({ type: 'Action.OpenUrl', ...a })) } : {}),
          },
        },
      ],
    };
  }
  // Legacy Office 365 connector card ("teams"); Microsoft is retiring these connectors.
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: title,
    title,
    text: line,
    ...(p.url ? { potentialAction: [{ '@type': 'OpenUri', name: open, targets: [{ os: 'default', uri: p.url }] }] } : {}),
  };
}

/** Legacy header: X-Kernel-Signature = sha256=HMAC(secret, body). */
export function sign(secret: string, body: string) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/** Standard Webhooks (standardwebhooks.com) signature: base64 HMAC-SHA256 over "id.timestamp.body". */
export function standardSignature(secret: string, id: string, timestamp: number, body: string) {
  const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'utf8');
  return 'v1,' + createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

const newSecret = () => 'whsec_' + randomBytes(32).toString('base64');

/**
 * Sends due deliveries (or the given ones). Rows are claimed with a short lease in their own transaction, sent
 * without holding a database connection, then updated one by one. Safe with several replicas.
 */
export async function processDeliveries(options: { limit?: number; ids?: number[] } = {}) {
  const { claimed } = await processOutbox({
    table: 'webhook_deliveries', leaseSeconds: 120, limit: options.limit ?? 20, order: 'next_attempt_at',
    filter: { sql: '($2::bigint[] IS NULL OR id = ANY($2))', params: [options.ids ?? null] },
    // The delivery log in the API shows these names; they predate the shared outbox columns.
    columns: { lease: 'locked_until', error: 'last_error', sentAt: 'delivered_at', sent: 'ok', noError: null },
    // Exponential backoff: 30 s, 2 min, 8 min, 32 min, ~2 h; then give up.
    retryIn: (attempts) => (attempts >= MAX_ATTEMPTS ? null : 30 * 4 ** (attempts - 1)),
    send: async (d: any, extra) => {
      extra.response_status = null;
      // A request task (#44) gets its single-use callback token as it is sent; a task no longer open is not sent.
      const payload = d.event === 'request.task' ? await requestTaskPayload.call(d.payload) : d.payload;
      if (!payload) throw new GiveUp('Skipped: the task is no longer open');
      const { rows: w } = await query('SELECT url, format, secret FROM webhooks WHERE id = $1', [d.webhook_id]);
      if (!w[0]) throw new GiveUp('The webhook is gone');
      const body = JSON.stringify(formatBody(w[0].format, payload));
      const secret = decryptSecret(w[0].secret);
      const id = `msg_${d.id}`;
      const timestamp = Math.floor(Date.now() / 1000);
      const res = await outboundFetch(w[0].url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Kernel-Webhooks/1',
          'webhook-id': id,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': standardSignature(secret, id, timestamp, body),
          'X-Kernel-Event': d.event,
          'X-Kernel-Delivery': String(d.id),
          'X-Kernel-Signature': sign(secret, body),
        },
        body,
        maxBytes: 16_384,
      });
      extra.response_status = res.status;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
  });
  return claimed;
}

/** Deletes old deliveries: successful after KERNEL_WEBHOOK_RETENTION_DAYS (30), failed after 3x that. */
export async function pruneDeliveries() {
  const days = Number(process.env.KERNEL_WEBHOOK_RETENTION_DAYS ?? 30);
  const { rowCount } = await query(
    `DELETE FROM webhook_deliveries WHERE (status = 'ok' AND created_at < now() - $1 * interval '1 day')
       OR (status = 'failed' AND created_at < now() - $1 * 3 * interval '1 day')`,
    [days],
  );
  return rowCount ?? 0;
}

/** Encrypts secrets stored before encryption existed, once a key is configured. */
export async function encryptLegacySecrets(log: (msg: string) => void) {
  if (!secretsConfigured()) {
    const { rows } = await query('SELECT count(*)::int AS n FROM webhooks');
    if (rows[0].n > 0) log('KERNEL_SECRET_KEY is not set: webhook secrets are stored unencrypted. Set it to encrypt them.');
    return;
  }
  const { rows } = await query('SELECT id, secret FROM webhooks');
  for (const r of rows.filter((r) => !isEncrypted(r.secret))) {
    await query('UPDATE webhooks SET secret = $2 WHERE id = $1', [r.id, encryptSecret(r.secret)]);
  }
}

/** Queues action.overdue once per action when its due date passes. */
export async function notifyOverdueActions() {
  await tx(async (db) => {
    const { rows } = await db.query(
      `UPDATE problem_actions SET overdue_notified_at = now()
       WHERE status = 'open' AND due_date < current_date AND overdue_notified_at IS NULL
       RETURNING id, problem_id, title, due_date::text AS due_date, owner_id`,
    );
    for (const a of rows) {
      await enqueue(db, 'action.overdue', a.problem_id, null, `Action overdue: ${a.title} (due ${a.due_date})`, { action_id: a.id, due_date: a.due_date, owner_id: a.owner_id });
    }
  });
}

// ---- Administration ------------------------------------------------------------------------

export const webhookSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().max(2000).superRefine((v, ctx) => {
    const problem = checkUrl(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  }),
  format: z.enum(FORMATS).default('json'),
  events: z.array(z.enum(EVENTS)).default([]),
  /** For status.published: the services (refs) to carry updates for; none means every public service. */
  services: z.array(z.string().max(30)).max(50).default([]),
  active: z.boolean().default(true),
});

/** Service refs to ids; an unknown ref is refused. */
async function serviceIds(refs: string[]) {
  if (!refs.length) return [];
  const { rows } = await query("SELECT id FROM configuration_items WHERE class = 'service' AND ref = ANY($1)", [refs.map((r) => r.toUpperCase())]);
  if (rows.length !== new Set(refs.map((r) => r.toUpperCase())).size) throw badRequest('Every entry in services must be a service ref');
  return rows.map((r) => r.id as number);
}

const COLUMNS = `w.id, w.name, w.url, w.format, w.events, w.active, w.created_at,
  coalesce((SELECT array_agg(c.ref ORDER BY c.ref) FROM configuration_items c WHERE c.id = ANY(w.ci_ids)), '{}') AS services, coalesce(w.secret_rotated_at, w.created_at) AS secret_set_at,
  (SELECT count(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'failed')::int AS failed,
  (SELECT max(delivered_at) FROM webhook_deliveries d WHERE d.webhook_id = w.id) AS last_delivered_at`;

export async function listWebhooks() {
  return (await query(`SELECT ${COLUMNS} FROM webhooks w ORDER BY w.name`)).rows;
}

export async function createWebhook(input: z.infer<typeof webhookSchema>) {
  const secret = newSecret();
  const { rows } = await query(
    `INSERT INTO webhooks (name, url, format, events, active, secret, ci_ids) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.name, input.url, input.format, input.events, input.active, encryptSecret(secret), await serviceIds(input.services)],
  );
  await audit(null, { entity_type: 'webhook', entity_ref: String(rows[0].id), action: 'create', changes: { name: input.name, url: input.url, format: input.format, events: input.events, services: input.services, active: input.active } });
  // The secret is shown once, at creation; afterwards it can only be rotated.
  return { ...(await query(`SELECT ${COLUMNS} FROM webhooks w WHERE w.id = $1`, [rows[0].id])).rows[0], secret };
}

export async function updateWebhook(id: number, input: z.infer<typeof webhookSchema>) {
  const { rows: before } = await query(`SELECT w.name, w.url, w.format, w.events, w.active,
    coalesce((SELECT array_agg(c.ref ORDER BY c.ref) FROM configuration_items c WHERE c.id = ANY(w.ci_ids)), '{}') AS services FROM webhooks w WHERE w.id = $1`, [id]);
  if (!before[0]) throw notFound();
  await query('UPDATE webhooks SET name = $2, url = $3, format = $4, events = $5, active = $6, ci_ids = $7 WHERE id = $1', [
    id, input.name, input.url, input.format, input.events, input.active, await serviceIds(input.services),
  ]);
  const changed = Object.fromEntries(Object.entries(input).filter(([k, v]) => JSON.stringify(before[0][k]) !== JSON.stringify(v)).map(([k, v]) => [k, { from: before[0][k], to: v }]));
  await audit(null, { entity_type: 'webhook', entity_ref: String(id), action: 'update', changes: changed });
  return (await query(`SELECT ${COLUMNS} FROM webhooks w WHERE w.id = $1`, [id])).rows[0];
}

export async function deleteWebhook(id: number, reason: string) {
  const { rows } = await query('DELETE FROM webhooks WHERE id = $1 RETURNING name, url', [id]);
  if (!rows[0]) throw notFound();
  await audit(null, { entity_type: 'webhook', entity_ref: String(id), action: 'delete', changes: rows[0], reason });
}

/** Replaces the signing secret and returns the new one (shown once). */
export async function rotateSecret(id: number) {
  const secret = newSecret();
  const { rowCount } = await query('UPDATE webhooks SET secret = $2, secret_rotated_at = now() WHERE id = $1', [id, encryptSecret(secret)]);
  if (!rowCount) throw notFound();
  await audit(null, { entity_type: 'webhook', entity_ref: String(id), action: 'rotate_secret', changes: { secret: '[changed]' } });
  return { secret };
}

export async function deliveries(id: number) {
  return (
    await query(
      `SELECT id, event, status, attempts, response_status, last_error, created_at, delivered_at, next_attempt_at,
              payload->>'summary' AS summary, payload->'problem'->>'ref' AS ref
       FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 30`,
      [id],
    )
  ).rows;
}

/** Queues a test event and sends only that delivery, immediately. */
export async function ping(id: number) {
  const { rows } = await query('SELECT id FROM webhooks WHERE id = $1', [id]);
  if (!rows[0]) throw notFound();
  const { rows: created } = await query('INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1, $2, $3) RETURNING id', [
    id,
    'ping',
    JSON.stringify({ event: 'ping', occurred_at: new Date().toISOString(), summary: 'Test delivery from Kernel', problem: null, actor: null, data: {} }),
  ]);
  await audit(null, { entity_type: 'webhook', entity_ref: String(id), action: 'ping' });
  await processDeliveries({ ids: [created[0].id] });
  return (await deliveries(id))[0];
}
