// Confidential records (#61). They stay visible, but their free text is masked by the server for everyone except the
// people working on them (assignee, creator, the record's team) – unless they reveal it, which takes a reason and
// step-up, is audited, and lasts 15 minutes. Titles, statuses and other fields stay readable, so the record can be
// found and handled. Agents (MCP) and exports always get the masked text; AI models only with a provider that is
// allowed confidential data.
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, requireReason } from './audit.js';
import type { User } from './auth.js';
import { query, tx } from './db.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { authorize } from './policy.js';
import { typeForRef } from './records.js';

type Kind = 'problem' | 'incident' | 'change';
const TABLE: Record<Kind, string> = { problem: 'problems', incident: 'incidents', change: 'changes' };
const LOG: Record<Kind, [string, string]> = { problem: ['problem_activity', 'problem_id'], incident: ['incident_activity', 'incident_id'], change: ['change_activity', 'change_id'] };
const PREFIX: Record<string, Kind> = { PRB: 'problem', INC: 'incident', CHG: 'change' };
export const REVEAL_MINUTES = 15;

/** The free-text fields that are masked, wherever they appear inside a confidential record's data. */
export const MASKED_FIELDS = new Set([
  'description', 'root_cause', 'workaround', 'resolution', 'major_review', 'ec_risk', 'ec_fix_cost', 'ec_decision_note',
  'implementation_plan', 'test_plan', 'backout_plan', 'outcome', 'review', 'cancel_reason', 'hold_reason', 'reporter',
  'body', 'conclusion', 'note', 'summary', 'comment', 'snippet', 'excerpt',
]);

const kindOfRef = (ref: string) => PREFIX[ref.toUpperCase().match(/^[A-Z]+/)?.[0] ?? ''] as Kind | undefined;

let anyConfidential: { at: number; value: boolean } | null = null;
/** Most installations have none, and then nothing is parsed or looked up. */
async function confidentialExists() {
  if (anyConfidential && Date.now() - anyConfidential.at < 15_000) return anyConfidential.value;
  const { rows } = await query("SELECT EXISTS (SELECT 1 FROM problems WHERE classification = 'confidential') OR EXISTS (SELECT 1 FROM incidents WHERE classification = 'confidential') OR EXISTS (SELECT 1 FROM changes WHERE classification = 'confidential') AS any");
  anyConfidential = { at: Date.now(), value: rows[0].any };
  return anyConfidential.value;
}
export const forgetExists = () => { anyConfidential = null; };

/**
 * Of these refs, the confidential ones this user may not read in full right now. Agents (and exports) pass null:
 * they never read confidential text.
 */
export async function maskedRefs(user: { id: number } | null, refs: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!refs.length || !(await confidentialExists())) return out;
  for (const kind of ['problem', 'incident', 'change'] as Kind[]) {
    const mine = [...new Set(refs.filter((r) => kindOfRef(r) === kind).map((r) => r.toUpperCase()))];
    if (!mine.length) continue;
    const { rows } = await query(
      `SELECT r.ref,
              ($2::int IS NOT NULL AND (r.assignee_id = $2 OR r.created_by = $2
                OR EXISTS (SELECT 1 FROM team_members m WHERE m.user_id = $2 AND m.team_id = r.team_id)
                OR EXISTS (SELECT 1 FROM record_reveals v WHERE v.user_id = $2 AND v.record_type = $3 AND v.record_id = r.id AND v.expires_at > now()))) AS may_read
       FROM ${TABLE[kind]} r WHERE r.ref = ANY($1) AND r.classification = 'confidential'`,
      [mine, user?.id ?? null, kind],
    );
    for (const r of rows) if (!r.may_read) out.add(r.ref);
  }
  return out;
}

/**
 * Search must not be an oracle for masked text: a confidential record the viewer may not read is only found by its
 * title or ref, never because its description or comments matched (#61). Agents pass null.
 */
export async function onlyTitleMatches<T extends { ref: string; title?: string | null }>(user: { id: number } | null, hits: T[], q: string): Promise<T[]> {
  const masked = await maskedRefs(user, hits.map((h) => h.ref));
  if (!masked.size) return hits;
  const terms = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  return hits.filter((h) => {
    if (!masked.has(h.ref.toUpperCase())) return true;
    const title = (h.title ?? '').toLowerCase();
    return h.ref.toUpperCase() === q.trim().toUpperCase() || (terms.length > 0 && terms.every((t) => title.includes(t)));
  });
}

/** Masks free text in place: in objects that carry a masked ref, and – for a page about one record – everywhere. */
export function maskValue(value: unknown, masked: Set<string>, all = false, depth = 0): unknown {
  if (depth > 40 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const v of value) maskValue(v, masked, all, depth + 1);
    return value;
  }
  const o = value as Record<string, unknown>;
  const here = all || (typeof o.ref === 'string' && masked.has(o.ref.toUpperCase()));
  let hid = false;
  for (const k of Object.keys(o)) {
    if (here && MASKED_FIELDS.has(k) && typeof o[k] === 'string' && o[k]) {
      o[k] = null;
      hid = true;
    } else if (here && k === 'data' && o[k] && typeof o[k] === 'object') {
      // History entries keep what changed; the old and new values of masked fields are hidden.
      const d = o[k] as Record<string, unknown>;
      for (const f of Object.keys(d)) {
        if (MASKED_FIELDS.has(f) && d[f] !== null) d[f] = { masked: true };
        else maskValue(d[f], masked, here, depth + 2);
      }
    } else {
      maskValue(o[k], masked, here, depth + 1);
    }
  }
  if (here && typeof o.ref === 'string' && masked.has(o.ref.toUpperCase())) o.confidential_masked = true;
  else if (hid && depth === 0) o.confidential_masked = true;
  return value;
}

function collectRefs(value: unknown, out: Set<string>, depth = 0) {
  if (depth > 40 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const v of value) collectRefs(v, out, depth + 1); return; }
  const o = value as Record<string, unknown>;
  if (typeof o.ref === 'string' && kindOfRef(o.ref)) out.add(o.ref.toUpperCase());
  for (const v of Object.values(o)) collectRefs(v, out, depth + 1);
}

/** For a response: masks what this viewer may not read (pageRef: the record a page or export is about). */
export async function maskForViewer(user: { id: number } | null, value: unknown, pageRef?: string) {
  if (!(await confidentialExists())) return value;
  const refs = new Set<string>();
  collectRefs(value, refs);
  if (pageRef && kindOfRef(pageRef)) refs.add(pageRef.toUpperCase());
  const masked = await maskedRefs(user, [...refs]);
  if (!masked.size) return value;
  return maskValue(value, masked, !!pageRef && masked.has(pageRef.toUpperCase()));
}

// ---- Classification and reveal -----------------------------------------------------------------------------------

export const classifySchema = z.object({ classification: z.enum(['normal', 'confidential']), reason: z.string().max(1000).optional() });

export async function setClassification(user: User, ref: string, input: z.infer<typeof classifySchema>) {
  authorize(user, 'record.restrict');
  const reason = requireReason(input.reason);
  const kind = kindOfRef(ref);
  if (!kind) throw badRequest('Only problems, incidents and changes can be confidential');
  const result = await tx(async (db) => {
    const { rows } = await db.query(`SELECT id, ref, classification FROM ${TABLE[kind]} WHERE ref = $1 FOR UPDATE`, [ref.toUpperCase()]);
    const r = rows[0];
    if (!r) throw notFound(`${ref} not found`);
    if (r.classification === input.classification) return { ref: r.ref, classification: r.classification };
    await db.query(`UPDATE ${TABLE[kind]} SET classification = $2 WHERE id = $1`, [r.id, input.classification]);
    const [log, col] = LOG[kind];
    await db.query(`INSERT INTO ${log} (${col}, user_id, kind, body, data, channel) VALUES ($1, $2, 'update', $3, $4, 'web')`, [
      r.id, user.id, input.classification === 'confidential' ? `Marked confidential: ${reason}` : `No longer confidential: ${reason}`, JSON.stringify({ classification: { from: r.classification, to: input.classification } }),
    ]);
    let retired: string[] = [];
    if (kind === 'problem' && input.classification === 'confidential') {
      // A known-error article synced from the problem copies its text, so it is retired (not deleted).
      const { rows: a } = await db.query(
        `UPDATE articles SET status = 'retired', retired_at = now(), updated_at = now() WHERE problem_id = $1 AND synced_with_problem AND status <> 'retired' RETURNING id, ref`, [r.id]);
      for (const x of a) await db.query("INSERT INTO article_activity (article_id, kind, body, data) VALUES ($1, 'status', $2, $3)", [x.id, `Retired: ${r.ref} is confidential`, JSON.stringify({ to: 'retired', problem: r.ref })]);
      retired = a.map((x) => x.ref as string);
    }
    // Every instance drops its "nothing is confidential" shortcut at once.
    await db.query("SELECT pg_notify('kernel_live', 'classification:' || $1)", [r.id]);
    await audit(db, { entity_type: kind, entity_ref: r.ref, action: 'classification', changes: { classification: { from: r.classification, to: input.classification }, retired_articles: retired }, reason });
    return { ref: r.ref, classification: input.classification };
  });
  forgetExists();
  return result;
}

/** Shows a confidential record's text to this user for 15 minutes. Callers check step-up first. */
export async function reveal(user: User, ref: string, reasonInput: string | undefined) {
  const reason = requireReason(reasonInput);
  const kind = kindOfRef(ref);
  if (!kind) throw badRequest('Only problems, incidents and changes can be confidential');
  typeForRef(ref);
  return tx(async (db) => {
    const { rows } = await db.query(`SELECT id, ref, classification FROM ${TABLE[kind]} WHERE ref = $1`, [ref.toUpperCase()]);
    const r = rows[0];
    if (!r) throw notFound(`${ref} not found`);
    if (r.classification !== 'confidential') throw badRequest(`${r.ref} is not confidential`);
    const { rows: v } = await db.query(
      `INSERT INTO record_reveals (user_id, record_type, record_id, reason, expires_at) VALUES ($1, $2, $3, $4, now() + $5 * interval '1 minute')
       ON CONFLICT (user_id, record_type, record_id) DO UPDATE SET reason = EXCLUDED.reason, created_at = now(), expires_at = EXCLUDED.expires_at RETURNING expires_at`,
      [user.id, kind, r.id, reason, REVEAL_MINUTES],
    );
    const [log, col] = LOG[kind];
    await db.query(`INSERT INTO ${log} (${col}, user_id, kind, body, data, channel) VALUES ($1, $2, 'update', $3, '{}', 'web')`, [r.id, user.id, `Revealed the confidential text: ${reason}`]);
    await audit(db, { entity_type: kind, entity_ref: r.ref, action: 'reveal', changes: { minutes: REVEAL_MINUTES }, reason });
    return { ref: r.ref, expires_at: v[0].expires_at };
  });
}

/** Writing to a masked field needs the same right as reading it: no blind overwrites of text you cannot see. */
export async function assertMayWriteText(req: FastifyRequest, ref: string, body: unknown) {
  if (!req.user || !body || typeof body !== 'object') return;
  if (!Object.keys(body).some((k) => MASKED_FIELDS.has(k))) return;
  if ((await maskedRefs(req.user, [ref])).has(ref.toUpperCase())) throw forbidden(`${ref.toUpperCase()} is confidential. Reveal its text before you change it.`);
}
