// A one-time re-base of the audit trail (ADR 0001): entries written before the privacy rules (names, IP addresses,
// user agents and free text) and before the sensitive-data scanner (short code-like secrets kept verbatim) are rewritten
// with the rules new entries follow, and the hash chain is recomputed with the active key.
//
// Run by an operator as the database owner (the app role cannot change the append-only trail), never through the API:
//
//   docker compose exec app node server/dist/rebase-audit.js            dry run: what would change, nothing written
//   docker compose exec app node server/dist/rebase-audit.js --execute  rewrite, in one transaction
//
// Before: take and verify a backup, and keep it outside the rotation until the result is verified (docs/audit-rebase.md).
//
// The rewrite is bracketed by two ordinary audit entries, so it is itself in the trail and in the SIEM anchor stream:
// audit.chain_rebase_intent { head } before, and audit.chain_rebased { old_head, new_head, rows_rewritten, key_id } after.
import type pg from 'pg';
import { pathToFileURL } from 'node:url';
import { audit, digestOf, GENESIS, hashOf, minimise, verifyChain, withoutSecrets } from './audit.js';
import { asSystem } from './context.js';
import { withOwner } from './db.js';
import { activeKey } from './keys.js';
import { redact } from './sensitive.js';

interface Row {
  id: string; at: Date; actor_user_id: number | null; actor_name: string; actor_type: string; channel: string; token_prefix: string;
  ip: string; user_agent: string; request_id: string; entity_type: string; entity_ref: string; action: string;
  changes: Record<string, unknown>; reason: string; prev_hash: string; hash: string; hash_version: number; key_id: string | null;
}

export interface RebaseReport {
  rows: number;
  rows_rewritten: number;
  /** How many entries change per field (no values). */
  fields: Record<string, number>;
  /** Ids of a few entries per field, to look at before and after. */
  samples: Record<string, string[]>;
  moved_context: number;
  old_head: { id: string; hash: string } | null;
  new_head: { id: string; hash: string } | null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The rules new entries follow (audit.ts), applied to an old one. */
function rewrite(r: Row, usernames: Map<string, number>) {
  let entityRef = r.entity_ref;
  if ((r.entity_type === 'user' || r.entity_type === 'session') && entityRef && !entityRef.startsWith('#') && !entityRef.startsWith('hmac-sha256:')) {
    const id = usernames.get(entityRef.toLowerCase());
    entityRef = id ? `#${id}` : ((digestOf(entityRef) as { digest?: string }).digest ?? 'unknown account');
  }
  return {
    actor_name: '',
    ip: '',
    user_agent: '',
    entity_ref: entityRef,
    changes: minimise(JSON.parse(JSON.stringify(withoutSecrets(r.changes ?? {})))) as Record<string, unknown>,
    // Reasons are kept verbatim (they must not hold personal data); older ones are cleaned with the scanner.
    reason: redact(r.reason ?? '', ['secret', 'personal']).text,
  };
}

/** verifyChain's check, on the owner's connection and inside its transaction. */
async function verifyWithin(owner: pg.ClientBase): Promise<{ ok: boolean; broken_at?: string }> {
  let prev = GENESIS;
  let after = 0n;
  for (;;) {
    const { rows } = await owner.query<Row>('SELECT * FROM audit_log WHERE id > $1 ORDER BY id LIMIT 2000', [after.toString()]);
    if (!rows.length) return { ok: true };
    for (const r of rows) {
      if (r.prev_hash !== prev || hashOf(prev, { ...r, at: r.at.toISOString() }, r.hash_version, r.key_id) !== r.hash) return { ok: false, broken_at: r.id };
      prev = r.hash;
      after = BigInt(r.id);
    }
  }
}

/** Rewrites (or, without execute, only counts) every entry and recomputes the chain. `owner` is a connection as the database owner. */
export async function rebaseAudit(owner: pg.ClientBase, options: { execute: boolean; /** Tests only: runs just before the in-transaction check. */ beforeVerify?: (owner: pg.ClientBase) => Promise<void> }): Promise<RebaseReport> {
  const key = activeKey();
  if (!key) throw new Error('KERNEL_SECRET_KEY is needed: the chain is recomputed with the active key');
  await owner.query('BEGIN');
  try {
    // The same lock as every append, so nothing is written to the trail meanwhile.
    await owner.query('SELECT pg_advisory_xact_lock(4713)');
    const users = await owner.query('SELECT id, lower(username) AS username FROM users');
    const usernames = new Map(users.rows.map((u) => [u.username as string, u.id as number]));
    const report: RebaseReport = { rows: 0, rows_rewritten: 0, fields: {}, samples: {}, moved_context: 0, old_head: null, new_head: null };
    const head = await owner.query('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1');
    report.old_head = head.rows[0] ? { id: String(head.rows[0].id), hash: head.rows[0].hash } : null;
    if (options.execute) await owner.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    let prev = GENESIS;
    let after = 0n;
    for (;;) {
      const { rows } = await owner.query<Row>('SELECT * FROM audit_log WHERE id > $1 ORDER BY id LIMIT 2000', [after.toString()]);
      if (!rows.length) break;
      for (const r of rows) {
        report.rows++;
        const next = rewrite(r, usernames);
        const changed = (Object.keys(next) as (keyof typeof next)[]).filter((f) => !same(next[f], r[f] ?? ''));
        for (const f of changed) {
          report.fields[f] = (report.fields[f] ?? 0) + 1;
          if ((report.samples[f] ??= []).length < 5) report.samples[f].push(r.id);
        }
        if (changed.length) report.rows_rewritten++;
        if (r.ip || r.user_agent) report.moved_context++;
        const canonicalRow = { ...r, ...next, at: r.at.toISOString() };
        const hash = hashOf(prev, canonicalRow, 3, key.id);
        if (options.execute) {
          if (r.ip || r.user_agent) {
            // Kept for the usual time in audit_context (privacy.audit_context_days), dated by the entry.
            await owner.query('INSERT INTO audit_context (audit_id, ip, user_agent, created_at) VALUES ($1, nullif($2, \'\'), nullif($3, \'\'), $4) ON CONFLICT (audit_id) DO NOTHING', [r.id, r.ip, r.user_agent, r.at]);
          }
          await owner.query(
            `UPDATE audit_log SET actor_name = $2, ip = $3, user_agent = $4, entity_ref = $5, changes = $6, reason = $7,
               prev_hash = $8, hash = $9, hash_version = 3, key_id = $10 WHERE id = $1`,
            [r.id, next.actor_name, next.ip, next.user_agent, next.entity_ref, JSON.stringify(next.changes), next.reason, prev, hash, key.id],
          );
        }
        prev = hash;
        report.new_head = { id: r.id, hash };
        after = BigInt(r.id);
      }
    }
    if (options.execute) {
      await owner.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
      // Verify the rewritten chain inside the transaction: any mismatch rolls everything back, so a failed re-base
      // leaves the trail as it was (the backup stays the last resort, not the first).
      await options.beforeVerify?.(owner);
      const check = await verifyWithin(owner);
      if (!check.ok) throw new Error(`The recomputed chain does not verify at entry ${check.broken_at}; nothing was changed`);
      await owner.query('COMMIT');
    } else {
      await owner.query('ROLLBACK');
    }
    return report;
  } catch (err) {
    await owner.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** The whole procedure: intent entry, rewrite, result entry, verification. */
export async function runRebase(execute: boolean, log: (msg: string) => void = console.log) {
  return withOwner(async (owner) => {
    if (!execute) {
      const r = await rebaseAudit(owner, { execute: false });
      log(`Dry run: ${r.rows_rewritten} of ${r.rows} entries would change; IP/user agent of ${r.moved_context} would move to audit_context.`);
      for (const [f, n] of Object.entries(r.fields)) log(`  ${f}: ${n} (e.g. entries ${r.samples[f].join(', ')})`);
      return r;
    }
    const before = await owner.query('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1');
    await asSystem(() => audit(null, {
      entity_type: 'audit_log', entity_ref: 'chain', action: 'chain_rebase_intent',
      changes: { head: before.rows[0] ? { id: String(before.rows[0].id), hash: before.rows[0].hash } : null }, reason: 'Re-base of legacy entries (ADR 0001)',
    }));
    const r = await rebaseAudit(owner, { execute: true });
    await asSystem(() => audit(null, {
      entity_type: 'audit_log', entity_ref: 'chain', action: 'chain_rebased',
      changes: { old_head: r.old_head, new_head: r.new_head, rows_rewritten: r.rows_rewritten, key_id: activeKey()!.id }, reason: 'Re-base of legacy entries (ADR 0001)',
    }));
    const verified = await verifyChain();
    log(`Rewrote ${r.rows_rewritten} of ${r.rows} entries; chain ${verified.ok ? 'verifies' : `BROKEN at ${verified.broken_at}`} (${verified.checked} entries).`);
    // Verified inside the transaction already; this checks the committed trail with the app's own code path.
    if (!verified.ok) throw new Error('The chain does not verify after the re-base; restore the backup taken before it');
    return r;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runRebase(process.argv.includes('--execute'))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`Re-base failed: ${err.message}`);
      process.exit(1);
    });
}
