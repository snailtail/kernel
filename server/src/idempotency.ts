// Idempotency-Key for creating requests: a retry with the same key returns the stored response instead of
// performing the action twice (important for agents and integrations that retry on timeouts).
import type { FastifyInstance } from 'fastify';
import { query } from './db.js';

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyKey?: string;
  }
}

export function registerIdempotency(app: FastifyInstance<any, any, any, any>) {
  app.addHook('preHandler', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !req.user || !['POST', 'PUT', 'PATCH'].includes(req.method) || !req.url.startsWith('/api/')) return;
    if (key.length > 200) return reply.code(400).send({ error: 'Idempotency-Key is too long' });
    const route = `${req.method} ${req.url.split('?')[0]}`;
    const { rows } = await query(
      `INSERT INTO idempotency_keys (key, user_id, route) VALUES ($1, $2, $3) ON CONFLICT (user_id, key) DO NOTHING RETURNING key`,
      [key, req.user.id, route],
    );
    if (rows[0]) {
      req.idempotencyKey = key;
      return;
    }
    const { rows: existing } = await query('SELECT route, status, body FROM idempotency_keys WHERE user_id = $1 AND key = $2', [req.user.id, key]);
    const e = existing[0];
    if (e.route !== route) return reply.code(422).send({ error: 'This Idempotency-Key was used for a different request' });
    if (e.status === null) return reply.code(409).send({ error: 'A request with this Idempotency-Key is still in progress' });
    reply.header('Idempotent-Replayed', 'true');
    return reply.code(e.status).send(e.body);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.idempotencyKey || !req.user) return payload;
    if (reply.statusCode >= 200 && reply.statusCode < 300) {
      let body: unknown = null;
      try {
        body = typeof payload === 'string' ? JSON.parse(payload) : null;
      } catch {
        body = null;
      }
      await query('UPDATE idempotency_keys SET status = $3, body = $4 WHERE user_id = $1 AND key = $2', [req.user.id, req.idempotencyKey, reply.statusCode, JSON.stringify(body)]);
    } else {
      // Failed requests may be retried with the same key.
      await query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2', [req.user.id, req.idempotencyKey]);
    }
    return payload;
  });
}

export async function pruneIdempotencyKeys() {
  await query("DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'");
}
