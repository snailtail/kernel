// The unified audit trail: every change writes an entry in the same transaction, chained by hash.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { currentContext } from './context.js';
import { query, tx } from './db.js';
import { badRequest } from './errors.js';
import { logger } from './log.js';

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export interface AuditEntry {
  entity_type: string;
  entity_ref?: string;
  action: string;
  changes?: Record<string, unknown>;
  reason?: string;
  /** Acting user when the request context has none yet (e.g. at sign-in). */
  actor?: { id: number; name: string };
}

const auditLogger = logger.child({ event: { dataset: 'kernel.audit' } });
const GENESIS = '0'.repeat(64);

/** JSON with sorted keys at every level, so jsonb's own key ordering cannot change the hash. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`).join(',')}}`;
}

const canonical = (r: Record<string, unknown>) =>
  stableStringify([r.at, r.actor_user_id, r.actor_name, r.actor_type, r.channel, r.token_prefix, r.ip, r.request_id, r.entity_type, r.entity_ref, r.action, r.changes, r.reason]);

export const hashOf = (prev: string, row: Record<string, unknown>) => createHash('sha256').update(prev).update(canonical(row)).digest('hex');

/** Secrets never enter the audit trail, only the fact that they changed. */
function redact(changes: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes)) out[k] = /secret|password|token_hash|mfa_secret/i.test(k) ? '[changed]' : v;
  return out;
}

/** Writes an audit entry. Pass the transaction's client so the entry commits (or rolls back) with the change. */
export async function audit(db: Db | null, entry: AuditEntry) {
  const base = currentContext();
  const ctx = entry.actor ? { ...base, userId: entry.actor.id, userName: entry.actor.name, actorType: base.actorType === 'anonymous' ? ('user' as const) : base.actorType } : base;
  const write = async (client: Db) => {
    // Serialise appends so the hash chain has a single order.
    await client.query('SELECT pg_advisory_xact_lock(4713)');
    const { rows: last } = await client.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prev = last[0]?.hash ?? GENESIS;
    const { rows: now } = await client.query('SELECT clock_timestamp() AS at');
    const row = {
      at: (now[0].at as Date).toISOString(),
      actor_user_id: ctx.userId,
      actor_name: ctx.userName,
      actor_type: ctx.actorType,
      channel: ctx.channel,
      token_prefix: ctx.tokenPrefix,
      ip: ctx.ip,
      request_id: ctx.requestId,
      entity_type: entry.entity_type,
      entity_ref: entry.entity_ref ?? '',
      action: entry.action,
      changes: JSON.parse(JSON.stringify(redact(entry.changes ?? {}))),
      reason: entry.reason ?? '',
    };
    const hash = hashOf(prev, row);
    const { rows: inserted } = await client.query(
      `INSERT INTO audit_log (at, actor_user_id, actor_name, actor_type, channel, token_prefix, ip, user_agent, request_id,
         entity_type, entity_ref, action, changes, reason, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [row.at, row.actor_user_id, row.actor_name, row.actor_type, row.channel, row.token_prefix, row.ip, ctx.userAgent, row.request_id,
        row.entity_type, row.entity_ref, row.action, JSON.stringify(row.changes), row.reason, prev, hash],
    );
    // A copy for the SIEM / Elasticsearch (#8): no field values, which may be long or sensitive. The id and hash
    // give an external anchor, so a rewritten chain in the database can be detected against Elasticsearch.
    auditLogger.info(
      { event: { kind: 'event', category: ['configuration'], action: `${entry.entity_type}.${entry.action}` }, audit: { id: Number(inserted[0].id), hash }, user: { id: ctx.userId, name: ctx.userName }, actor_type: ctx.actorType, entity: { type: entry.entity_type, ref: entry.entity_ref }, fields: Object.keys(entry.changes ?? {}), reason: entry.reason || undefined },
      `${entry.entity_type}.${entry.action}`,
    );
  };
  if (db) await write(db);
  else await tx(write);
}

/** For sensitive administrative actions the reason is mandatory. */
export function requireReason(reason: string | undefined): string {
  if (!reason?.trim()) throw badRequest('A reason is required for this action', );
  return reason.trim().slice(0, 1000);
}

export const auditQuerySchema = z.object({
  actor: z.string().max(100).optional(),
  actor_type: z.string().max(20).optional(),
  entity_type: z.string().max(50).optional(),
  entity_ref: z.string().max(100).optional(),
  action: z.string().max(100).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  ip: z.string().max(60).optional(),
  before_id: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export async function queryAudit(f: z.infer<typeof auditQuerySchema>) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.actor) add('actor_name ILIKE ?', `%${f.actor}%`);
  if (f.actor_type) add('actor_type = ?', f.actor_type);
  if (f.entity_type) add('entity_type = ?', f.entity_type);
  if (f.entity_ref) add('entity_ref ILIKE ?', `%${f.entity_ref}%`);
  if (f.action) add('action ILIKE ?', `%${f.action}%`);
  if (f.ip) add('ip = ?', f.ip);
  if (f.from) add('at >= ?::timestamptz', f.from);
  if (f.to) add("at < ?::date + interval '1 day'", f.to);
  if (f.before_id) add('id < ?', f.before_id);
  params.push(f.limit);
  const { rows } = await query(
    `SELECT id, at, actor_user_id, actor_name, actor_type, channel, token_prefix, ip, user_agent, request_id,
            entity_type, entity_ref, action, changes, reason
     FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** Recomputes the hash chain; returns the first broken entry, if any. */
export async function verifyChain(): Promise<{ ok: boolean; checked: number; broken_at?: number }> {
  let prev = GENESIS;
  let checked = 0;
  let after = 0;
  for (;;) {
    const { rows } = await query(
      `SELECT id, at, actor_user_id, actor_name, actor_type, channel, token_prefix, ip, request_id, entity_type, entity_ref, action, changes, reason, prev_hash, hash
       FROM audit_log WHERE id > $1 ORDER BY id LIMIT 5000`,
      [after],
    );
    if (!rows.length) return { ok: true, checked };
    for (const r of rows) {
      const row = { ...r, at: (r.at as Date).toISOString() };
      if (r.prev_hash !== prev || hashOf(prev, row) !== r.hash) {
        logger.error({ event: { dataset: 'kernel.security', action: 'audit.chain_broken' }, audit_id: r.id }, 'Audit trail hash chain mismatch');
        return { ok: false, checked, broken_at: Number(r.id) };
      }
      prev = r.hash;
      checked++;
      after = Number(r.id);
    }
  }
}

let lastVerification: { at: string; ok: boolean; checked: number; broken_at?: number } | null = null;
export const lastChainVerification = () => lastVerification;

/** Verifies the chain hourly (as the system actor); a mismatch is logged as a security event. */
export function startChainVerification(log: (msg: string) => void) {
  const run = () =>
    verifyChain()
      .then((r) => {
        lastVerification = { at: new Date().toISOString(), ...r };
        if (!r.ok) log(`Audit trail hash chain broken at entry ${r.broken_at}`);
      })
      .catch((err) => log(`Audit verification failed: ${err.message}`));
  setTimeout(run, 10_000).unref();
  setInterval(run, 3600_000).unref();
}
