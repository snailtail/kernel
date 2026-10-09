// Idempotency-Key for creating records (#35, fixed in #77). Opt-in per route: only routes that create ordinary
// records (problems, actions, comments, links, analyses) use it – never routes that return secrets. The caller is
// authorised again before a stored response is replayed, and the request body must match the original.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { stableStringify } from './audit.js';
import { query } from './db.js';
import { HttpError } from './errors.js';
import { authorize, type Action } from './policy.js';

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyKey?: string;
  }
  interface FastifyContextConfig {
    /** Policy action of a record-creating route that supports Idempotency-Key. */
    idempotent?: Action;
  }
}

const IN_FLIGHT_SECONDS = 60;
const fingerprintOf = (scope: string, body: unknown) => createHash('sha256').update(scope).update(stableStringify(body ?? null)).digest('hex');

type Claim = { replay: { status: number; body: unknown } } | { claimed: true };

/** Claims a key for this request, or returns the stored response of the original one. */
async function claim(userId: number, key: string, scope: string, fingerprint: string): Promise<Claim> {
  if (key.length > 200) throw new HttpError(400, 'Idempotency-Key is too long');
  // Abandoned in-flight claims (a crash before the response was stored) can be taken over.
  const { rows } = await query(
    `INSERT INTO idempotency_keys (key, user_id, route, fingerprint) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, key) DO UPDATE SET route = excluded.route, fingerprint = excluded.fingerprint, created_at = now()
       WHERE idempotency_keys.status IS NULL AND idempotency_keys.created_at < now() - $5 * interval '1 second'
         AND idempotency_keys.route = excluded.route AND idempotency_keys.fingerprint = excluded.fingerprint
     RETURNING key`,
    [key, userId, scope, fingerprint, IN_FLIGHT_SECONDS],
  );
  if (rows[0]) return { claimed: true };
  const { rows: existing } = await query('SELECT route, fingerprint, status, body FROM idempotency_keys WHERE user_id = $1 AND key = $2', [userId, key]);
  const e = existing[0];
  if (e.route !== scope || e.fingerprint !== fingerprint) throw new HttpError(422, 'This Idempotency-Key was used for a different request');
  if (e.status === null) throw new HttpError(409, 'A request with this Idempotency-Key is still in progress');
  return { replay: { status: e.status, body: e.body } };
}

async function store(userId: number, key: string, status: number, body: unknown) {
  await query('UPDATE idempotency_keys SET status = $3, body = $4 WHERE user_id = $1 AND key = $2', [userId, key, status, JSON.stringify(body)]);
}

async function release(userId: number, key: string) {
  await query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND status IS NULL', [userId, key]);
}

export function registerIdempotency(app: FastifyInstance<any, any, any, any>) {
  app.addHook('preHandler', async (req, reply) => {
    const action = req.routeOptions.config?.idempotent;
    const key = req.headers['idempotency-key'];
    if (!action || typeof key !== 'string' || !req.user) return;
    // Authorise first: a stored response must never be handed out to someone who may no longer do this.
    authorize(req.user, action);
    const scope = `${req.method} ${req.url.split('?')[0]}`;
    const result = await claim(req.user.id, key, scope, fingerprintOf(scope, req.body));
    if ('replay' in result) {
      reply.header('Idempotent-Replayed', 'true');
      return reply.code(result.replay.status).send(result.replay.body);
    }
    req.idempotencyKey = key;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.idempotencyKey || !req.user) return payload;
    if (reply.statusCode >= 200 && reply.statusCode < 300 && typeof payload === 'string') {
      let body: unknown = null;
      try {
        body = JSON.parse(payload);
      } catch {
        body = null;
      }
      await store(req.user.id, req.idempotencyKey, reply.statusCode, body);
    } else {
      await release(req.user.id, req.idempotencyKey); // failed requests may be retried with the same key
    }
    return payload;
  });
}

/** The same guarantee for MCP tools: runs fn once per key and returns the stored result for retries. */
export async function idempotent<T>(userId: number, key: string | undefined, scope: string, input: unknown, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const result = await claim(userId, key, `mcp ${scope}`, fingerprintOf(`mcp ${scope}`, input));
  if ('replay' in result) return result.replay.body as T;
  try {
    const value = await fn();
    await store(userId, key, 200, value);
    return value;
  } catch (err) {
    await release(userId, key);
    throw err;
  }
}

export async function pruneIdempotencyKeys() {
  await query("DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'");
}
