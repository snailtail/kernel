// The unified audit trail: every change writes an entry in the same transaction, chained by hash.
import { scan } from './sensitive.js';
import { activeKey, derive, keyById } from './keys.js';
import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { currentContext } from './context.js';
import { afterCommit, query, tx } from './db.js';
import { badRequest } from './errors.js';
import { logger } from './log.js';
import { fromAudit, originOf } from './security-events.js';

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

// The dataset sits in each line's event object: a child logger binding `event` would give the line two event keys.
const auditLogger = logger;

/** Receives each committed entry's id and hash (tests replace it to observe anchors). */
export let anchorSink: (a: { id: number; hash: string }) => void = () => {};
export const setAnchorSink = (fn: typeof anchorSink) => {
  anchorSink = fn;
};
export const GENESIS = '0'.repeat(64);

/** JSON with sorted keys at every level, so jsonb's own key ordering cannot change the hash. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`).join(',')}}`;
}

const canonical = (r: Record<string, unknown>) =>
  stableStringify([r.at, r.actor_user_id, r.actor_name, r.actor_type, r.channel, r.token_prefix, r.ip, r.request_id, r.entity_type, r.entity_ref, r.action, r.changes, r.reason]);

/**
 * Version 2 entries use HMAC-SHA-256 keyed from KERNEL_SECRET_KEY, so someone with only database access cannot
 * append or rewrite entries with valid hashes. Version 1 (plain SHA-256) is used when no key is configured.
 */
/**
 * Version 3 entries (#63) name their key (key_id) and include it in the HMAC, so a key can be rotated and an entry
 * cannot be moved to another key. Version 2 entries used the key "k0".
 */
const chainKey = (id: string, version: number) => {
  const k = keyById(id);
  if (!k) return null;
  // Version 2 used sha256 of a label and the key; version 3 derives with HKDF.
  return version === 2 ? createHash('sha256').update('kernel-audit-chain:' + k.raw).digest() : derive('kernel-audit-chain', k);
};
export const currentHashVersion = () => (activeKey() ? 3 : 1);

export function hashOf(prev: string, row: Record<string, unknown>, version = 1, keyId?: string | null) {
  if (version === 3 || version === 2) {
    const id = version === 2 ? 'k0' : String(keyId ?? '');
    const key = chainKey(id, version);
    if (!key) throw new Error(`Key ${id} is needed to verify keyed audit entries`);
    const h = createHmac('sha256', key).update(prev);
    if (version === 3) h.update(`key:${id}:`);
    return h.update(canonical(row)).digest('hex');
  }
  return createHash('sha256').update(prev).update(canonical(row)).digest('hex');
}

/**
 * Personal data stays out of the append-only trail (#57): personal fields and free text become a digest and length;
 * short code-like values (statuses, refs, ids, dates, numbers) stay readable. The full texts are in the record
 * histories, which can be anonymised; the digest still proves what was there.
 */
const PERSONAL = /^(email|display_name|username|reporter|ip|address|phone|caller|name_of_person|person_name|title|department|location|external_id)$/i;
const TOKEN = /^[A-Za-z0-9_.:\/#+-]{0,64}$/;
/**
 * Keyed, so a digest of a short personal value (a name, an email, a personal identity number) cannot be reversed by
 * trying candidates without KERNEL_SECRET_KEY, which is not in the database. Equal texts still give equal digests.
 */
export const digestOf = (v: string) => {
  const k = activeKey();
  return k
    // codeql[js/insufficient-password-hash] -- a keyed HMAC that minimises personal fields in the audit trail; passwords are never audited
    ? { digest: `hmac-sha256:${k.id}:${createHmac('sha256', derive('kernel-audit-digest', k)).update(v).digest('hex')}`, length: v.length }
    // Without a key a plain hash of a short value could be reversed, so only the fact and size of the change remain.
    : { changed: true, length: v.length };
};
/** An already minimised value ({digest, length} or {changed, length}): left as it is, so minimising is idempotent. */
const isMinimised = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && 'length' in v && ('digest' in v || 'changed' in v) && Object.keys(v).length === 2;

export function minimise(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (value === '[changed]') return value;
    // Short code-like values stay readable – unless the scanner sees a secret or personal data in them (#61).
    return PERSONAL.test(key) || !TOKEN.test(value) || scan(value).length ? digestOf(value) : value;
  }
  if (isMinimised(value)) return value;
  if (Array.isArray(value)) return value.map((v) => minimise(v, key));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    // In { field: { from, to } } the field name decides, not "from"/"to".
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, minimise(v, k === 'from' || k === 'to' ? key : k)]));
  }
  return value;
}

/** Secrets never enter the audit trail, only the fact that they changed. */
export function withoutSecrets(changes: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes)) out[k] = /secret|password|passwd|api[_-]?key|access[_-]?token|token_hash|credential|private[_-]?key/i.test(k) ? '[changed]' : v;
  return out;
}

/** Writes an audit entry. Pass the transaction's client so the entry commits (or rolls back) with the change. */
export async function audit(db: Db | null, entry: AuditEntry) {
  const base = currentContext();
  const ctx = entry.actor ? { ...base, userId: entry.actor.id, userName: entry.actor.name, actorType: base.actorType === 'anonymous' ? ('user' as const) : base.actorType } : base;
  const write = async (client: Db) => {
    // A username as reference becomes the user's id, so no name lands in the trail.
    let entityRef = entry.entity_ref ?? '';
    if ((entry.entity_type === 'user' || entry.entity_type === 'session') && entityRef && !entityRef.startsWith('#')) {
      const { rows: u } = await client.query('SELECT id FROM users WHERE username = $1', [entityRef]);
      const d = digestOf(entityRef);
      entityRef = u[0] ? `#${u[0].id}` : ((d as { digest?: string }).digest ?? 'unknown account');
    }
    // Serialise appends so the hash chain has a single order.
    await client.query('SELECT pg_advisory_xact_lock(4713)');
    const { rows: last } = await client.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prev = last[0]?.hash ?? GENESIS;
    const { rows: now } = await client.query('SELECT clock_timestamp() AS at');
    const row = {
      at: (now[0].at as Date).toISOString(),
      actor_user_id: ctx.userId,
      // Names are joined from users when shown; an erased user shows as "deleted user #id".
      actor_name: '',
      actor_type: ctx.actorType,
      channel: ctx.channel,
      token_prefix: ctx.tokenPrefix,
      // IP and user agent are kept in audit_context for a limited time instead.
      ip: '',
      request_id: ctx.requestId,
      entity_type: entry.entity_type,
      entity_ref: entityRef,
      action: entry.action,
      changes: minimise(JSON.parse(JSON.stringify(withoutSecrets(entry.changes ?? {})))) as Record<string, unknown>,
      reason: entry.reason ?? '',
    };
    const version = currentHashVersion();
    const keyId = version === 3 ? activeKey()!.id : null;
    const hash = hashOf(prev, row, version, keyId);
    const { rows: inserted } = await client.query(
      `INSERT INTO audit_log (at, actor_user_id, actor_name, actor_type, channel, token_prefix, ip, user_agent, request_id,
         entity_type, entity_ref, action, changes, reason, prev_hash, hash, hash_version, key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
      [row.at, row.actor_user_id, row.actor_name, row.actor_type, row.channel, row.token_prefix, row.ip, '', row.request_id,
        row.entity_type, row.entity_ref, row.action, JSON.stringify(row.changes), row.reason, prev, hash, version, keyId],
    );
    if (ctx.ip || ctx.userAgent) await client.query('INSERT INTO audit_context (audit_id, ip, user_agent) VALUES ($1, $2, $3)', [inserted[0].id, ctx.ip ?? null, ctx.userAgent ?? null]);
    // A copy for the SIEM / Elasticsearch (#8): no field values, which may be long or sensitive. The id and hash
    // give an external anchor, so a rewritten chain in the database can be detected against Elasticsearch.
    // Emitted only after commit, so a rolled-back change leaves no anchor.
    const anchor = { id: Number(inserted[0].id), hash };
    afterCommit(client, () => anchorSink(anchor));
    // Sign-ins, role and credential changes, exports and reveals are also security events (#64).
    const origin = { ...originOf(), userId: ctx.userId, actorType: ctx.actorType };
    afterCommit(client, () => fromAudit({ ...entry, entity_ref: entityRef }, origin));
    afterCommit(client, () => auditLogger.info(
      { event: { dataset: 'kernel.audit', kind: 'event', category: ['configuration'], action: `${entry.entity_type}.${entry.action}` }, audit: { id: Number(inserted[0].id), hash }, user: { id: ctx.userId }, actor_type: ctx.actorType, entity: { type: entry.entity_type, ref: entry.entity_ref }, fields: Object.keys(entry.changes ?? {}), reason: entry.reason || undefined },
      `${entry.entity_type}.${entry.action}`,
    ));
  };
  if (db) await write(db);
  else await tx(write);
}

/** For sensitive administrative actions the reason is mandatory. */

export function requireReason(reason: string | undefined): string {
  if (!reason?.trim()) throw badRequest('A reason is required for this action', );
  // Reasons are kept verbatim in the append-only trail (ADR 0001), so they must not carry personal details.
  if (scan(reason.slice(0, 1000)).some((f) => f.class === 'personal')) throw badRequest('The reason seems to contain an email address or a personal identity number. Refer to people by their account or a record ref instead.');
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

/** `entity_refs` (not part of the query schema) matches these refs exactly: the history of one record. */
export async function queryAudit(f: z.infer<typeof auditQuerySchema> & { entity_refs?: string[] }) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  // Names come from users (an erased user shows as "deleted user #id"); IP and user agent from audit_context while kept.
  const actorName = "coalesce(nullif(a.actor_name, ''), u.display_name, CASE WHEN a.actor_user_id IS NOT NULL THEN 'deleted user #' || a.actor_user_id END)";
  if (f.actor) add(`${actorName} ILIKE ?`, `%${f.actor}%`);
  if (f.actor_type) add('a.actor_type = ?', f.actor_type);
  if (f.entity_type) add('a.entity_type = ?', f.entity_type);
  if (f.entity_ref) add('a.entity_ref ILIKE ?', `%${f.entity_ref}%`);
  if (f.entity_refs) add('a.entity_ref = ANY(?)', f.entity_refs);
  if (f.action) add('a.action ILIKE ?', `%${f.action}%`);
  if (f.ip) add("coalesce(nullif(a.ip, ''), x.ip) = ?", f.ip);
  if (f.from) add('a.at >= ?::timestamptz', f.from);
  if (f.to) add("a.at < ?::date + interval '1 day'", f.to);
  if (f.before_id) add('a.id < ?', f.before_id);
  params.push(f.limit);
  const { rows } = await query(
    `SELECT a.id, a.at, a.actor_user_id, ${actorName} AS actor_name, a.actor_type, a.channel, a.token_prefix,
            coalesce(nullif(a.ip, ''), x.ip) AS ip, coalesce(nullif(a.user_agent, ''), x.user_agent) AS user_agent, a.request_id,
            a.entity_type, a.entity_ref, a.action, a.changes, a.reason
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id AND u.erased_at IS NULL LEFT JOIN audit_context x ON x.audit_id = a.id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** Recomputes the hash chain; returns the first broken entry, if any. */
export async function verifyChain(): Promise<{ ok: boolean; checked: number; broken_at?: number; error?: string }> {
  let prev = GENESIS;
  let checked = 0;
  let after = 0;
  let sawKeyed = false;
  for (;;) {
    const { rows } = await query(
      `SELECT id, at, actor_user_id, actor_name, actor_type, channel, token_prefix, ip, request_id, entity_type, entity_ref, action, changes, reason, prev_hash, hash, hash_version, key_id
       FROM audit_log WHERE id > $1 ORDER BY id LIMIT 5000`,
      [after],
    );
    if (!rows.length) return { ok: true, checked };
    for (const r of rows) {
      const row = { ...r, at: (r.at as Date).toISOString() };
      const needed = r.hash_version === 2 ? 'k0' : r.hash_version === 3 ? r.key_id : null;
      if (needed && !chainKey(needed, r.hash_version)) return { ok: false, checked, broken_at: Number(r.id), error: `Key ${needed} is needed to verify keyed entries; add it back to the keyring` };
      // A version 1 entry after keyed ones means someone appended without the key.
      if (r.prev_hash !== prev || hashOf(prev, row, r.hash_version, r.key_id) !== r.hash || (r.hash_version === 1 && sawKeyed)) {
        logger.error({ event: { dataset: 'kernel.security', action: 'audit.chain_broken' }, audit_id: r.id }, 'Audit trail hash chain mismatch');
        return { ok: false, checked, broken_at: Number(r.id) };
      }
      prev = r.hash;
      if (r.hash_version >= 2) sawKeyed = true;
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
