// Removing sensitive text from a record and its history (#61). Secrets are redacted on the way in, but text written
// before that – or personal details that should not have been written at all – can still sit in a record's fields,
// comments, actions, analyses, links and text attachments. A manager or administrator can remove it, with
// step-up and a reason. The fact of every change stays (the history keeps its entries, with "[REDACTED]" in place of
// the text), and the removal itself is recorded in the record's history and the audit trail – without the text.
import { z } from 'zod';
import { audit, digestOf, requireReason } from './audit.js';
import type { User } from './auth.js';
import { tx } from './db.js';
import type { Db } from './problems.js';
import { badRequest, notFound } from './errors.js';
import { authorize } from './policy.js';
import { textKindOfRef, typeForRef, type TextPlace } from './records.js';
import { addEntry } from './activity.js';
import { redact } from './sensitive.js';
import { sha256Hex } from './core/hash.js';

// Every place a record's free text can be is its type's textPlaces (records.ts). Codes, statuses, refs and ids are
// left alone.

export const redactHistorySchema = z.object({
  /** Remove everything the scanner sees as a secret. */
  secrets: z.boolean().default(false),
  /** Remove this exact text wherever it occurs (a name, an account number…). */
  // At least 4 characters, so a stray "a" or "not" cannot rewrite a record's history.
  text: z.string().trim().min(4, 'The text to remove must be at least 4 characters').max(500).optional(),
  reason: z.string().max(1000).optional(),
  /** Count what would be removed, change nothing. The dialog shows this before anything is removed. */
  dry_run: z.boolean().default(false),
});

/** Thrown (empty) to roll back a dry run after counting with the very same statements that would apply it. */
class RollBack extends Error {}

/** Returns the cleaned string and how many replacements were made. */
function cleaner(input: z.infer<typeof redactHistorySchema>) {
  return (value: string): [string, number] => {
    let out = value;
    let n = 0;
    if (input.secrets) {
      const r = redact(out);
      if (r.types.length) {
        n += (r.text.match(/\[REDACTED:/g)?.length ?? 0) - (out.match(/\[REDACTED:/g)?.length ?? 0);
        out = r.text;
      }
    }
    if (input.text && out.includes(input.text)) {
      n += out.split(input.text).length - 1;
      out = out.split(input.text).join('[REDACTED]');
    }
    return [out, n];
  };
}

function cleanJson(value: unknown, clean: (s: string) => [string, number], count: { n: number }, depth = 0): unknown {
  if (depth > 32) return value;
  if (typeof value === 'string') {
    const [out, n] = clean(value);
    count.n += n;
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => cleanJson(v, clean, count, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanJson(v, clean, count, depth + 1)]));
  return value;
}

async function cleanPlace(db: Db, place: TextPlace, recordId: number, clean: (s: string) => [string, number]) {
  const cols = [...place.columns, ...(place.json ?? [])];
  const { rows } = await db.query(`SELECT ctid::text AS row_id, ${cols.join(', ')} FROM ${place.table} WHERE ${place.key} = $1`, [recordId]);
  let total = 0;
  for (const row of rows) {
    const set: Record<string, unknown> = {};
    for (const c of place.columns) {
      if (typeof row[c] !== 'string') continue;
      const [out, n] = clean(row[c]);
      if (n) { set[c] = out; total += n; }
    }
    for (const c of place.json ?? []) {
      if (row[c] == null) continue;
      const count = { n: 0 };
      const out = cleanJson(row[c], clean, count);
      if (count.n) { set[c] = JSON.stringify(out); total += count.n; }
    }
    const keys = Object.keys(set);
    if (keys.length) {
      await db.query(`UPDATE ${place.table} SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE ctid = $1::tid`, [row.row_id, ...keys.map((k) => set[k])]);
    }
  }
  return total;
}

export async function redactHistory(user: User, ref: string, input: z.infer<typeof redactHistorySchema>) {
  authorize(user, 'record.redact');
  const reason = input.dry_run ? '' : requireReason(input.reason);
  if (!input.secrets && !input.text) throw badRequest('Choose what to remove: secrets, a text, or both');
  typeForRef(ref);
  const t = textKindOfRef(ref);
  if (!t) throw badRequest('Only problems, incidents, changes, improvements and requests have a history to clean');
  const type = t.type;
  if (input.text && input.text.toUpperCase().includes(ref.toUpperCase())) throw badRequest('The text cannot include the record\'s own reference');
  const clean = cleaner(input);
  let preview: { removed: number; places: Record<string, number>; outside: unknown; dry_run: true } | null = null;
  try {
  return await tx(async (db) => {
    // The caller must see the record (row-level security).
    const { rows } = await db.query(`SELECT id, ref FROM ${t.table} WHERE ref = $1 FOR UPDATE`, [ref.toUpperCase()]);
    const record = rows[0];
    if (!record) throw notFound(`${ref} not found`);
    const places: Record<string, number> = {};
    for (const place of t.textPlaces) {
      const n = await cleanPlace(db, place, record.id, clean);
      if (n) places[place.table] = n;
    }
    // Text attachments of the record.
    const { rows: files } = await db.query(
      `SELECT b.attachment_id, b.variant, convert_from(b.data, 'UTF8') AS text FROM attachments a JOIN attachment_blobs b ON b.attachment_id = a.id
       WHERE a.record_type = $1 AND a.record_ref = $2 AND a.kind = 'text'`,
      [type, record.ref],
    );
    for (const f of files) {
      const [out, n] = clean(f.text);
      if (!n) continue;
      const data = Buffer.from(out, 'utf8');
      await db.query('UPDATE attachment_blobs SET data = $3 WHERE attachment_id = $1 AND variant = $2', [f.attachment_id, f.variant, data]);
      await db.query('UPDATE attachments SET size = $2, sha256 = $3 WHERE id = $1', [f.attachment_id, data.length, sha256Hex(data)]);
      places.attachments = (places.attachments ?? 0) + n;
    }
    // Copies Kernel keeps of the record's text: in-app notifications and webhook payloads (queued ones then go out clean).
    const { rows: notes } = await db.query('SELECT id, title, summary FROM notifications WHERE ref = $1', [record.ref]);
    for (const n of notes) {
      const [title, a] = clean(n.title ?? '');
      const [summary, b] = clean(n.summary ?? '');
      if (a + b) {
        await db.query('UPDATE notifications SET title = $2, summary = $3 WHERE id = $1', [n.id, title, summary]);
        places.notifications = (places.notifications ?? 0) + a + b;
      }
    }
    // Practice webhooks carry the record under its type, automation rules' under "record".
    const { rows: deliveries } = await db.query(`SELECT id, payload FROM webhook_deliveries WHERE $1 IN (payload->'${type}'->>'ref', payload->'record'->>'ref')`, [record.ref]);
    for (const d of deliveries) {
      const count = { n: 0 };
      const payload = cleanJson(d.payload, clean, count);
      if (count.n) {
        await db.query('UPDATE webhook_deliveries SET payload = $2 WHERE id = $1', [d.id, JSON.stringify(payload)]);
        places.webhook_deliveries = (places.webhook_deliveries ?? 0) + count.n;
      }
    }
    const total = Object.values(places).reduce((a, b) => a + b, 0);
    // What Kernel cannot reach: copies already sent, and records copied from this one (each cleaned on its own).
    const { rows: sent } = await db.query(
      `SELECT d.channel, count(*)::int AS n FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
       WHERE n.ref = $1 AND d.status = 'sent' GROUP BY d.channel`, [record.ref]);
    const { rows: delivered } = await db.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE $1 IN (payload->'${type}'->>'ref', payload->'record'->>'ref') AND delivered_at IS NOT NULL`, [record.ref]);
    const { rows: articles } = await db.query(
      `SELECT ref, title FROM articles WHERE (problem_id = $1 AND $2 = 'problem' AND NOT synced_with_problem) OR (source_incident_id = $1 AND $2 = 'incident')`, [record.id, type]);
    const { rows: images } = await db.query("SELECT filename FROM attachments WHERE record_type = $1 AND record_ref = $2 AND kind = 'image' ORDER BY id", [type, record.ref]);
    const outside = {
      sent: Object.fromEntries(sent.map((r) => [r.channel, r.n])) as Record<string, number>,
      webhooks_delivered: delivered[0].n as number,
      articles: articles as { ref: string; title: string }[],
      images: images.map((i) => i.filename as string),
    };
    if (input.dry_run) {
      preview = { removed: total, places, outside, dry_run: true };
      throw new RollBack();
    }
    if (!total) return { removed: 0, places, outside };
    await addEntry(db, type, record.id, { userId: user.id, kind: 'update', body: `Removed sensitive text from the record and its history: ${reason}`, data: { removed: total, places }, channel: 'web' });
    // The text itself never goes into the trail; a keyed digest proves what was removed.
    await audit(db, { entity_type: type, entity_ref: record.ref, action: 'redact_history', changes: { secrets: input.secrets, text: input.text ? digestOf(input.text) : null, removed: total, places }, reason });
    return { removed: total, places, outside };
  });
  } catch (err) {
    if (err instanceof RollBack && preview) return preview;
    throw err;
  }
}
