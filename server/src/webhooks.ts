// Outbound webhooks. Events are queued in webhook_deliveries inside the same transaction as the change that caused
// them (outbox pattern) and sent by a background worker with HMAC signatures and retries.
import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { query, tx } from './db.js';
import { notFound } from './errors.js';

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
] as const;
export type EventType = (typeof EVENTS)[number];
export const FORMATS = ['json', 'slack', 'teams'] as const;

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

const problemUrl = (ref: string) => (config.publicUrl ? `${config.publicUrl.replace(/\/$/, '')}/problems/${ref}` : null);

/** Queues deliveries for all active webhooks subscribed to the event. Call inside the change's transaction. */
export async function enqueue(db: Db, event: EventType, problemId: number, actorId: number | null, summary: string, data: object) {
  const { rows: hooks } = await db.query(
    `SELECT id FROM webhooks WHERE active AND (cardinality(events) = 0 OR $1 = ANY(events))`,
    [event],
  );
  if (!hooks.length) return;
  const { rows } = await db.query(
    `SELECT p.ref, p.title, p.status, p.priority, p.is_major, a.username AS assignee,
            u.username AS actor_username, u.display_name AS actor_name
     FROM problems p LEFT JOIN users a ON a.id = p.assignee_id LEFT JOIN users u ON u.id = $2 WHERE p.id = $1`,
    [problemId, actorId],
  );
  const p = rows[0];
  if (!p) return;
  const payload = {
    event,
    occurred_at: new Date().toISOString(),
    problem: { ref: p.ref, title: p.title, status: p.status, priority: p.priority, is_major: p.is_major, assignee: p.assignee, url: problemUrl(p.ref) },
    actor: p.actor_username ? { username: p.actor_username, display_name: p.actor_name } : null,
    summary,
    data,
  };
  for (const h of hooks) {
    await db.query('INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1, $2, $3)', [h.id, event, JSON.stringify(payload)]);
  }
}

/** Formats the payload for the webhook's target (generic JSON, Slack or Teams incoming webhooks). */
export function formatBody(format: string, payload: any) {
  if (format === 'json') return payload;
  const p = payload.problem ?? {};
  const who = payload.actor?.display_name ?? 'Kernel';
  const title = p.ref ? `${p.ref}: ${p.title}` : 'Kernel';
  const line = `${who}: ${payload.summary || payload.event}`;
  if (format === 'slack') {
    const link = p.url ? `<${p.url}|${title}>` : `*${title}*`;
    return { text: `${link}\n${line}` };
  }
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: title,
    title,
    text: line,
    ...(p.url ? { potentialAction: [{ '@type': 'OpenUri', name: 'Open in Kernel', targets: [{ os: 'default', uri: p.url }] }] } : {}),
  };
}

export function sign(secret: string, body: string) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/** Sends due deliveries. Safe with several replicas (SKIP LOCKED). Returns the number processed. */
export async function processDeliveries(limit = 20) {
  return tx(async (db) => {
    const { rows } = await db.query(
      `SELECT d.id, d.event, d.payload, d.attempts, w.url, w.format, w.secret
       FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.status = 'pending' AND d.next_attempt_at <= now()
       ORDER BY d.next_attempt_at LIMIT $1 FOR UPDATE OF d SKIP LOCKED`,
      [limit],
    );
    for (const d of rows) {
      const body = JSON.stringify(formatBody(d.format, d.payload));
      let status: number | null = null;
      let error: string | null = null;
      try {
        const res = await fetch(d.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Kernel-Webhooks/1',
            'X-Kernel-Event': d.event,
            'X-Kernel-Delivery': String(d.id),
            'X-Kernel-Signature': sign(d.secret, body),
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (err) {
        error = (err as Error).message;
      }
      const attempts = d.attempts + 1;
      if (!error) {
        await db.query(`UPDATE webhook_deliveries SET status = 'ok', attempts = $2, response_status = $3, last_error = NULL, delivered_at = now() WHERE id = $1`, [d.id, attempts, status]);
      } else {
        // Exponential backoff: 30 s, 2 min, 8 min, 32 min, ~2 h; then give up.
        const failed = attempts >= MAX_ATTEMPTS;
        await db.query(
          `UPDATE webhook_deliveries SET status = $2, attempts = $3, response_status = $4, last_error = $5,
             next_attempt_at = now() + $6 * interval '1 second' WHERE id = $1`,
          [d.id, failed ? 'failed' : 'pending', attempts, status, error.slice(0, 500), 30 * 4 ** (attempts - 1)],
        );
      }
    }
    return rows.length;
  });
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

export function startWorker(log: (msg: string) => void) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      while ((await processDeliveries()) > 0);
    } catch (err) {
      log(`Webhook delivery failed: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  };
  setInterval(tick, 5000).unref();
  setInterval(() => notifyOverdueActions().catch((err) => log(`Overdue check failed: ${err.message}`)), 3600_000).unref();
  notifyOverdueActions().catch(() => {});
}

// ---- Administration ------------------------------------------------------------------------

export const webhookSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().max(2000).refine((v) => /^https?:\/\//i.test(v), 'URL must start with http:// or https://'),
  format: z.enum(FORMATS).default('json'),
  events: z.array(z.enum(EVENTS)).default([]),
  active: z.boolean().default(true),
});

const COLUMNS = `w.id, w.name, w.url, w.format, w.events, w.active, w.created_at,
  (SELECT count(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'failed')::int AS failed,
  (SELECT max(delivered_at) FROM webhook_deliveries d WHERE d.webhook_id = w.id) AS last_delivered_at`;

export async function listWebhooks() {
  return (await query(`SELECT ${COLUMNS} FROM webhooks w ORDER BY w.name`)).rows;
}

export async function createWebhook(input: z.infer<typeof webhookSchema>) {
  const secret = randomBytes(24).toString('base64url');
  const { rows } = await query(
    `INSERT INTO webhooks (name, url, format, events, active, secret) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.name, input.url, input.format, input.events, input.active, secret],
  );
  return { ...(await query(`SELECT ${COLUMNS} FROM webhooks w WHERE w.id = $1`, [rows[0].id])).rows[0], secret };
}

export async function updateWebhook(id: number, input: z.infer<typeof webhookSchema>) {
  const { rowCount } = await query('UPDATE webhooks SET name = $2, url = $3, format = $4, events = $5, active = $6 WHERE id = $1', [
    id, input.name, input.url, input.format, input.events, input.active,
  ]);
  if (!rowCount) throw notFound();
  return (await query(`SELECT ${COLUMNS} FROM webhooks w WHERE w.id = $1`, [id])).rows[0];
}

export async function deleteWebhook(id: number) {
  const { rowCount } = await query('DELETE FROM webhooks WHERE id = $1', [id]);
  if (!rowCount) throw notFound();
}

export async function revealSecret(id: number) {
  const { rows } = await query('SELECT secret FROM webhooks WHERE id = $1', [id]);
  if (!rows[0]) throw notFound();
  return rows[0].secret as string;
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

/** Queues a test event and sends it immediately. */
export async function ping(id: number) {
  const { rows } = await query('SELECT id FROM webhooks WHERE id = $1', [id]);
  if (!rows[0]) throw notFound();
  await query('INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1, $2, $3)', [
    id,
    'ping',
    JSON.stringify({ event: 'ping', occurred_at: new Date().toISOString(), summary: 'Test delivery from Kernel', problem: null, actor: null, data: {} }),
  ]);
  await processDeliveries();
  return (await deliveries(id))[0];
}
