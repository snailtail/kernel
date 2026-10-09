// Inbound monitoring webhooks (#30): one URL per configured source, authenticated with the source's token (header,
// or query string for tools that cannot set headers), optionally signed (Standard Webhooks) with replay protection.
// Each adapter parses its tool's payload strictly and produces normalised events; payloads are never stored.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { query } from './db.js';
import { badRequest, forbidden, notFound, unauthorized } from './errors.js';
import { eventSchema, processEvents, type NormalisedEvent } from './events.js';
import { authorize } from './policy.js';
import { decryptSecret, encryptSecret } from './secrets.js';

export const SOURCE_KINDS = ['generic', 'alertmanager', 'uptime_kuma', 'azure_monitor', 'op5'] as const;
type Kind = (typeof SOURCE_KINDS)[number];

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const SIGNATURE_TOLERANCE_S = 300;
/** Events whose own timestamp is older than this are refused as replays (for formats that carry a send time). */
const MAX_EVENT_AGE_MS = 60 * 60_000;

// ---- Adapters ----------------------------------------------------------------------------------

const iso = (d: Date) => d.toISOString();
const notTooOld = (at: Date) => {
  if (Number.isNaN(at.getTime())) throw badRequest('Invalid timestamp');
  if (Date.now() - at.getTime() > MAX_EVENT_AGE_MS) throw badRequest('Event is older than the replay window (1 hour)');
  return at;
};
const hostOf = (v?: string) => {
  if (!v) return undefined;
  try {
    if (/^[a-z]+:\/\//i.test(v)) return new URL(v).hostname;
  } catch {
    /* not a URL */
  }
  return v.replace(/:\d+$/, '');
};

const alertmanagerSchema = z.object({
  version: z.string().optional(),
  status: z.enum(['firing', 'resolved']),
  alerts: z
    .array(
      z.object({
        status: z.enum(['firing', 'resolved']),
        labels: z.record(z.string(), z.string()),
        annotations: z.record(z.string(), z.string()).default({}),
        startsAt: z.string(),
        endsAt: z.string().optional(),
        generatorURL: z.string().optional(),
        fingerprint: z.string().max(100).optional(),
      }),
    )
    .min(1)
    .max(500),
});
const AM_SEVERITY: Record<string, NormalisedEvent['severity']> = { critical: 'critical', page: 'critical', error: 'major', major: 'major', warning: 'warning', minor: 'minor', info: 'info', none: 'info' };

const kumaSchema = z.object({
  heartbeat: z
    .object({ status: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]), time: z.string(), msg: z.string().default('') })
    .nullable()
    .optional(),
  monitor: z.object({ id: z.number().optional(), name: z.string(), url: z.string().nullable().optional(), hostname: z.string().nullable().optional() }).nullable().optional(),
  msg: z.string().default(''),
});

const azureSchema = z.object({
  schemaId: z.literal('azureMonitorCommonAlertSchema'),
  data: z.object({
    essentials: z.object({
      alertId: z.string().max(500),
      alertRule: z.string().max(200),
      severity: z.enum(['Sev0', 'Sev1', 'Sev2', 'Sev3', 'Sev4']),
      monitorCondition: z.enum(['Fired', 'Resolved']),
      alertTargetIDs: z.array(z.string().max(500)).default([]),
      configurationItems: z.array(z.string().max(255)).default([]),
      firedDateTime: z.string(),
      resolvedDateTime: z.string().optional(),
      description: z.string().max(2000).optional(),
    }),
  }),
});
const AZURE_SEVERITY = { Sev0: 'critical', Sev1: 'major', Sev2: 'minor', Sev3: 'warning', Sev4: 'info' } as const;

/** The JSON an OP5/Naemon notification command posts (see README). */
const op5Schema = z.object({
  host_name: z.string().min(1).max(255),
  service_description: z.string().max(200).optional(),
  state: z.enum(['OK', 'WARNING', 'CRITICAL', 'UNKNOWN', 'UP', 'DOWN', 'UNREACHABLE']),
  output: z.string().max(2000).default(''),
  notification_type: z.enum(['PROBLEM', 'RECOVERY', 'ACKNOWLEDGEMENT', 'FLAPPINGSTART', 'FLAPPINGSTOP', 'DOWNTIMESTART', 'DOWNTIMEEND', 'CUSTOM']).default('PROBLEM'),
  timestamp: z.number().int().positive(),
  host_address: z.string().max(255).optional(),
});
const OP5_SEVERITY = { OK: 'clear', UP: 'clear', WARNING: 'warning', UNKNOWN: 'minor', CRITICAL: 'critical', DOWN: 'critical', UNREACHABLE: 'major' } as const;

/** Parses a payload of the given kind into normalised events. Throws 400 on anything that does not fit. */
export function adapt(kind: Kind, body: unknown): NormalisedEvent[] {
  const parse = <T>(schema: z.ZodType<T>) => {
    const r = schema.safeParse(body);
    if (!r.success) throw badRequest(`Not a valid ${kind} payload: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return r.data;
  };
  switch (kind) {
    case 'generic': {
      const b = parse(z.union([z.object({ events: z.array(eventSchema).min(1).max(500) }), eventSchema]));
      return 'events' in b ? b.events : [b];
    }
    case 'alertmanager':
      // Alertmanager re-sends firing alerts with their original startsAt, so it has no replay window;
      // replays cannot move an alert backwards because state changes are ordered by occurred_at.
      return parse(alertmanagerSchema).alerts.map((a) => ({
        source_event_id: a.fingerprint,
        host: hostOf(a.labels.instance ?? a.labels.host ?? a.labels.node ?? a.labels.pod),
        check: (a.labels.alertname ?? 'alert').slice(0, 200),
        severity: a.status === 'resolved' ? 'clear' : (AM_SEVERITY[(a.labels.severity ?? 'warning').toLowerCase()] ?? 'warning'),
        message: (a.annotations.summary ?? a.annotations.description ?? '').slice(0, 2000),
        occurred_at: iso(new Date(a.status === 'resolved' && a.endsAt ? a.endsAt : a.startsAt)),
        url: a.generatorURL && /^https?:\/\//.test(a.generatorURL) ? a.generatorURL.slice(0, 2000) : undefined,
      }));
    case 'uptime_kuma': {
      const b = parse(kumaSchema);
      if (!b.heartbeat || !b.monitor) return []; // "Test" notifications carry no heartbeat
      const at = notTooOld(new Date(b.heartbeat.time.replace(' ', 'T') + (/[zZ+]/.test(b.heartbeat.time.slice(10)) ? '' : 'Z')));
      return [{
        host: hostOf(b.monitor.hostname ?? b.monitor.url ?? undefined),
        check: `uptime: ${b.monitor.name}`.slice(0, 200),
        severity: (['critical', 'clear', 'warning', 'info'] as const)[b.heartbeat.status],
        message: (b.heartbeat.msg || b.msg).slice(0, 2000),
        occurred_at: iso(at),
        url: b.monitor.url && /^https?:\/\//.test(b.monitor.url) ? b.monitor.url : undefined,
      }];
    }
    case 'azure_monitor': {
      const e = parse(azureSchema).data.essentials;
      const resolved = e.monitorCondition === 'Resolved';
      const at = notTooOld(new Date(resolved && e.resolvedDateTime ? e.resolvedDateTime : e.firedDateTime));
      return [{
        source_event_id: e.alertId,
        ci_source_id: e.alertTargetIDs[0],
        host: e.configurationItems[0],
        check: e.alertRule,
        severity: resolved ? 'clear' : AZURE_SEVERITY[e.severity],
        message: e.description ?? '',
        occurred_at: iso(at),
      }];
    }
    case 'op5': {
      const b = parse(op5Schema);
      if (!['PROBLEM', 'RECOVERY'].includes(b.notification_type)) return [];
      const at = notTooOld(new Date(b.timestamp * 1000));
      return [{
        host: b.host_name,
        ci_source_id: b.host_name,
        check: b.service_description || 'host',
        severity: OP5_SEVERITY[b.state],
        message: b.output,
        occurred_at: iso(at),
      }];
    }
  }
}

// ---- Sources -----------------------------------------------------------------------------------

export const sourceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(SOURCE_KINDS),
  ci_source_system: z.string().trim().max(100).default(''),
  signed: z.boolean().default(false),
});

const newToken = () => `kernel_evt_${randomBytes(24).toString('base64url')}`;

export async function listSources(user: User) {
  authorize(user, 'webhook.manage');
  const { rows } = await query(
    `SELECT id, name, kind, token_prefix, signing_secret IS NOT NULL AS signed, ci_source_system, enabled, created_at, last_received_at, received_count, rejected_count
     FROM event_sources ORDER BY name`,
  );
  return rows.map((r) => ({ ...r, url: `/api/event-hooks/${r.id}` }));
}

export async function createSource(user: User, input: z.infer<typeof sourceSchema>) {
  authorize(user, 'webhook.manage');
  if (input.signed && input.kind !== 'generic') throw badRequest('Signing is supported for the generic kind; other tools authenticate with the token');
  const token = newToken();
  const secret = input.signed ? `whsec_${randomBytes(32).toString('base64')}` : null;
  try {
    const { rows } = await query(
      `INSERT INTO event_sources (name, kind, token_hash, token_prefix, signing_secret, ci_source_system, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.name, input.kind, sha256(token), token.slice(0, 16), secret ? encryptSecret(secret) : null, input.ci_source_system, user.id],
    );
    await audit(null, { entity_type: 'event_source', entity_ref: input.name, action: 'create', changes: { kind: input.kind, signed: input.signed, ci_source_system: input.ci_source_system } });
    // Shown once; only hashes (token) or encrypted values (secret) are stored.
    return { id: rows[0].id, url: `/api/event-hooks/${rows[0].id}`, token, signing_secret: secret };
  } catch (err: any) {
    if (err.code === '23505') throw badRequest('A source with that name already exists');
    throw err;
  }
}

export async function rotateSource(user: User, id: number) {
  authorize(user, 'webhook.manage');
  const token = newToken();
  const { rows } = await query('UPDATE event_sources SET token_hash = $2, token_prefix = $3 WHERE id = $1 RETURNING name', [id, sha256(token), token.slice(0, 16)]);
  if (!rows[0]) throw notFound('Source not found');
  await audit(null, { entity_type: 'event_source', entity_ref: rows[0].name, action: 'rotate_token', changes: {} });
  return { token };
}

export async function updateSource(user: User, id: number, input: { enabled?: boolean; ci_source_system?: string }) {
  authorize(user, 'webhook.manage');
  const { rows } = await query(
    'UPDATE event_sources SET enabled = coalesce($2, enabled), ci_source_system = coalesce($3, ci_source_system) WHERE id = $1 RETURNING name',
    [id, input.enabled ?? null, input.ci_source_system ?? null],
  );
  if (!rows[0]) throw notFound('Source not found');
  await audit(null, { entity_type: 'event_source', entity_ref: rows[0].name, action: 'update', changes: input });
  return { ok: true };
}

export async function deleteSource(user: User, id: number) {
  authorize(user, 'webhook.manage');
  const { rows } = await query('DELETE FROM event_sources WHERE id = $1 RETURNING name', [id]);
  if (!rows[0]) throw notFound('Source not found');
  await audit(null, { entity_type: 'event_source', entity_ref: rows[0].name, action: 'delete', changes: {} });
}

// ---- Receiving ---------------------------------------------------------------------------------

function tokenFrom(req: FastifyRequest) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const header = req.headers['x-kernel-token'];
  if (typeof header === 'string') return header.trim();
  const q = (req.query as Record<string, unknown>)?.token;
  return typeof q === 'string' ? q : '';
}

function verifySignature(secret: string, req: FastifyRequest, raw: string) {
  const id = req.headers['webhook-id'];
  const ts = Number(req.headers['webhook-timestamp']);
  const sig = req.headers['webhook-signature'];
  if (typeof id !== 'string' || !id || typeof sig !== 'string' || !Number.isFinite(ts)) throw unauthorized('Signed source: webhook-id, webhook-timestamp and webhook-signature are required');
  if (Math.abs(Date.now() / 1000 - ts) > SIGNATURE_TOLERANCE_S) throw unauthorized('Signature timestamp outside the allowed window');
  const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret);
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest();
  const ok = sig.split(' ').some((part) => {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw unauthorized('Invalid signature');
  return id.slice(0, 200);
}

/** Authenticates, verifies and processes one webhook call for a source. */
export async function receiveHook(req: FastifyRequest, sourceId: number, raw: string) {
  const { rows } = await query('SELECT * FROM event_sources WHERE id = $1', [sourceId]);
  const source = rows[0];
  const token = tokenFrom(req);
  const given = Buffer.from(sha256(token), 'hex');
  const ok = !!source && !!token && timingSafeEqual(given, Buffer.from(source.token_hash, 'hex'));
  const reject = async (err: Error) => {
    if (source) await query('UPDATE event_sources SET rejected_count = rejected_count + 1 WHERE id = $1', [source.id]);
    throw err;
  };
  if (!ok) return reject(unauthorized('Unknown source or invalid token'));
  if (!source.enabled) return reject(forbidden('This event source is disabled'));
  if (source.signing_secret) {
    let messageId: string;
    try {
      messageId = verifySignature(decryptSecret(source.signing_secret), req, raw);
    } catch (err) {
      return reject(err as Error);
    }
    const { rowCount } = await query('INSERT INTO event_hook_messages (source_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [source.id, messageId]);
    if (!rowCount) return reject(unauthorized('Replayed message'));
  }
  let events: NormalisedEvent[];
  try {
    events = adapt(source.kind, req.body);
  } catch (err) {
    return reject(err as Error);
  }
  const results = await processEvents(source.name, source.ci_source_system, events);
  await query('UPDATE event_sources SET last_received_at = now(), received_count = received_count + $2 WHERE id = $1', [source.id, events.length]);
  return { accepted: results.filter((r) => r.outcome !== 'error').length, results };
}
