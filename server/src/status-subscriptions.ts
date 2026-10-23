// Subscriptions to service status (#46). Staff follow services and hear through their own notification channels
// (#48). People outside sign up on the public page for public services only: a confirmation mail with a single-use
// link (double opt-in), and a signed one-click unsubscribe in every mail. Contacts of organisations that use a service
// hear about updates a person published. Outside recipients only ever get the published text under public names
// (audience.ts forOutside); every send is a row in status_deliveries, which is also the communication log.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { User } from './auth.js';
import { forOutside } from './audience.js';
import { audit } from './audit.js';
import { query } from './db.js';
import { badRequest, notFound } from './errors.js';
import { activeKey, keyring } from './keys.js';
import { mailConfigured, sendOutsideMail } from './notifications.js';
import { authorize } from './policy.js';
import type { Db } from './problems.js';
import { rateLimit } from './ratelimit.js';
import { pageSettings, STATUS_LABEL } from './status.js';
import { absoluteUrl } from './core/url.js';
import { sha256Hex } from './core/hash.js';
import { cap } from './core/text.js';

const CONFIRM_HOURS = 48;

// ---- Staff following services ------------------------------------------------------------------

export async function followService(user: User, ref: string, follow: boolean) {
  authorize(user, 'ci.read');
  const { rows } = await query("SELECT id FROM configuration_items WHERE ref = $1 AND class = 'service'", [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`Service ${ref} not found`);
  if (follow) await query('INSERT INTO status_follows (user_id, ci_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, rows[0].id]);
  else await query('DELETE FROM status_follows WHERE user_id = $1 AND ci_id = $2', [user.id, rows[0].id]);
  return { ref: ref.toUpperCase(), following: follow };
}

/** Followers of these services, for an update; the supporting teams hear about it separately. */
export async function followers(db: Db, ciIds: number[], exclude: number[]) {
  const { rows } = await db.query('SELECT DISTINCT user_id FROM status_follows WHERE ci_id = ANY($1) AND NOT (user_id = ANY($2))', [ciIds, exclude]);
  return rows.map((r) => r.user_id as number);
}

// ---- Signing up from the public page -------------------------------------------------------------

export const signUpSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  /** Public names from the page; none means every public service. */
  services: z.array(z.string().trim().max(100)).max(50).default([]),
});

/** The one answer to every sign-up, so nobody learns whether an address is already subscribed. */
export const SIGNED_UP = 'If the address can receive mail, a confirmation is on its way. Follow the link in it to start receiving updates.';

/** Whether the public page can offer sign-up (it is on, and Kernel can send mail). */
export const signUpOpen = async () => mailConfigured() && (await pageSettings()).public_enabled;

export async function signUp(input: z.infer<typeof signUpSchema>, ip: string) {
  if (!(await signUpOpen())) throw notFound('There is no public status page');
  rateLimit(`status-signup:ip:${ip}`, 10, 3600_000);
  // Per address, quietly: a sign-up beyond the limit gets the same answer and sends nothing, so a stranger can neither
  // flood someone's inbox nor tell from the answer that the address was used.
  try {
    rateLimit(`status-signup:to:${sha256Hex(input.email)}`, 3, 86400_000);
  } catch {
    return { message: SIGNED_UP };
  }
  const { rows: svc } = await query('SELECT ci_id FROM service_status WHERE public AND public_name = ANY($1)', [input.services]);
  if (input.services.length && !svc.length) throw badRequest('Choose services from the status page');
  const { rows } = await query(
    `INSERT INTO status_subscribers (email, pending_ci_ids) VALUES ($1, $2)
     ON CONFLICT ((lower(email))) DO UPDATE SET pending_ci_ids = excluded.pending_ci_ids,
       -- An unconfirmed sign-up gets its week from the latest request.
       created_at = CASE WHEN status_subscribers.confirmed_at IS NULL THEN now() ELSE status_subscribers.created_at END
     RETURNING id`,
    [input.email, svc.map((s) => s.ci_id)],
  );
  // One confirmation in flight per address; a new sign-up before it is sent changes what it confirms.
  await query(
    `INSERT INTO status_deliveries (kind, subscriber_id) SELECT 'confirm', $1
     WHERE NOT EXISTS (SELECT 1 FROM status_deliveries WHERE kind = 'confirm' AND subscriber_id = $1 AND status IN ('pending', 'sending'))`,
    [rows[0].id],
  );
  return { message: SIGNED_UP };
}

/** What a confirmation link would confirm, without changing anything (GET: mail scanners open every link). */
export async function checkConfirm(subscriberId: number, token: string) {
  const { rows } = await query(
    `SELECT s.pending_ci_ids,
            (SELECT array_agg(st.public_name ORDER BY st.public_name) FROM service_status st WHERE st.public AND st.ci_id = ANY(s.pending_ci_ids)) AS services
     FROM status_subscribers s WHERE s.id = $1 AND s.confirm_hash = $2 AND s.confirm_expires_at > now()`,
    [subscriberId, sha256Hex(token)],
  );
  if (!rows[0]) throw badRequest('This link has expired or was already used. Sign up again on the status page.');
  return rows[0].pending_ci_ids?.length ? `updates on ${(rows[0].services ?? []).join(', ')}` : 'updates on every service on the status page';
}

/** Confirms a sign-up (POST): the link works once. */
export async function confirm(subscriberId: number, token: string) {
  const { rows } = await query(
    `UPDATE status_subscribers SET confirmed_at = coalesce(confirmed_at, now()), ci_ids = coalesce(pending_ci_ids, ci_ids),
       pending_ci_ids = NULL, confirm_hash = NULL, confirm_expires_at = NULL
     WHERE id = $1 AND confirm_hash = $2 AND confirm_expires_at > now() RETURNING id`,
    [subscriberId, sha256Hex(token)],
  );
  if (!rows[0]) throw badRequest('This link has expired or was already used. Sign up again on the status page.');
  await audit(null, { entity_type: 'status_subscriber', entity_ref: `#${subscriberId}`, action: 'confirm' });
  return 'You will receive an email when there is an update. Every message has a link to unsubscribe.';
}

// ---- Unsubscribing (subscribers: s, organisation contacts: p) -------------------------------------

// Requesters of service requests (#44): r, a person who hears about their requests by mail.
type Who = 's' | 'p' | 'r';
// Signed with the active key; links signed with an older key in the keyring keep working after a rotation (#63).
const unsubscribeSigWith = (raw: string, who: Who, id: number) => createHmac('sha256', `kernel-status-unsubscribe:${raw}`).update(`${who}:${id}`).digest('base64url');

export function unsubscribeUrl(who: Who, id: number) {
  return absoluteUrl(`/status/unsubscribe?${who}=${id}&token=${unsubscribeSigWith(activeKey()?.raw ?? '', who, id)}`);
}

export function checkUnsubscribe(who: Who, id: number, token: string) {
  const given = Buffer.from(token);
  const valid = !!activeKey() && keyring().some((k) => {
    const expected = Buffer.from(unsubscribeSigWith(k.raw, who, id));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  if (!valid) throw badRequest('Invalid unsubscribe link');
  return who === 's' ? 'Stop email about service status?' : who === 'r' ? 'Stop email about your requests and the problems you reported?' : 'Stop email about service status for your organisation?';
}

/** One-click unsubscribe (POST only). A subscriber is deleted; a contact stays a contact for everything else. */
export async function unsubscribe(who: Who, id: number, token: string) {
  checkUnsubscribe(who, id, token);
  if (who === 's') {
    const { rowCount } = await query('DELETE FROM status_subscribers WHERE id = $1', [id]);
    if (rowCount) await audit(null, { entity_type: 'status_subscriber', entity_ref: `#${id}`, action: 'unsubscribe' });
  } else if (who === 'r') {
    const { rowCount } = await query('UPDATE people SET request_mail = false WHERE id = $1 AND request_mail', [id]);
    if (rowCount) await audit(null, { entity_type: 'person', entity_ref: `#${id}`, action: 'unsubscribe_requests' });
    return 'You will no longer receive email about your requests and the problems you reported.';
  } else {
    const { rowCount } = await query('UPDATE people SET status_contact = false WHERE id = $1 AND status_contact', [id]);
    if (rowCount) await audit(null, { entity_type: 'person', entity_ref: `#${id}`, action: 'unsubscribe_status' });
  }
  return 'You will no longer receive email about service status.';
}

// ---- Queueing a published update --------------------------------------------------------------------

/**
 * Called in the transaction of a public status update: queues mail to confirmed subscribers of its public services,
 * to the contacts of organisations that use them, and deliveries to status webhooks. Nothing goes out for an update
 * that is not public or has no public service, and a person always took the publish step.
 */
export async function queueOutside(db: Db, updateId: number) {
  const out = await forOutside(db, updateId);
  if (!out) return { subscribers: 0, contacts: 0, webhooks: 0 };
  const subscribers = await db.query(
    `INSERT INTO status_deliveries (kind, update_id, subscriber_id)
     SELECT 'subscriber', $1, id FROM status_subscribers WHERE confirmed_at IS NOT NULL AND (ci_ids = '{}' OR ci_ids && $2)`,
    [updateId, out.ci_ids],
  );
  const contacts = await db.query(
    `INSERT INTO status_deliveries (kind, update_id, person_id, organisation)
     SELECT DISTINCT ON (p.id) 'contact', $1, p.id, o.name
     FROM people p JOIN organisations o ON o.id = p.organisation_id AND o.active
     JOIN organisation_services os ON os.organisation_id = o.id AND os.ci_id = ANY($2)
     WHERE p.status_contact AND p.active AND p.erased_at IS NULL AND coalesce(p.email, '') <> ''`,
    [updateId, out.ci_ids],
  );
  const { rows: hooks } = await db.query(
    "SELECT id FROM webhooks WHERE active AND 'status.published' = ANY(events) AND (ci_ids = '{}' OR ci_ids && $1)",
    [out.ci_ids],
  );
  const { title } = await pageSettings();
  const payload = {
    event: 'status.published', occurred_at: new Date().toISOString(), title, url: absoluteUrl('/status'),
    summary: `${cap(out.published.phase)}: ${out.published.message}`.slice(0, 200), status_update: out.published, problem: null, actor: null, data: { status_update_id: updateId },
  };
  for (const h of hooks) await db.query('INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1, $2, $3)', [h.id, 'status.published', JSON.stringify(payload)]);
  return { subscribers: subscribers.rowCount ?? 0, contacts: contacts.rowCount ?? 0, webhooks: hooks.length };
}

/** A retracted update is not sent to anyone who has not had it yet, by mail or webhook. */
export async function cancelOutside(db: Db, updateId: number) {
  await db.query("UPDATE status_deliveries SET status = 'skipped', error = 'Retracted' WHERE update_id = $1 AND status = 'pending'", [updateId]);
  await db.query(
    "UPDATE webhook_deliveries SET status = 'failed', last_error = 'Retracted' WHERE event = 'status.published' AND status = 'pending' AND payload->'data'->>'status_update_id' = $1",
    [String(updateId)],
  );
}

// ---- The communication log ----------------------------------------------------------------------

/** Who outside was told what and when, per status update on the incident (for the post-incident review). */
export async function communicationLog(incidentId: number) {
  const { rows } = await query(
    `SELECT su.id, su.created_at, su.phase, su.status, su.message, su.public, su.retracted_at, u.display_name AS author,
            coalesce(json_agg(json_build_object('person_id', d.person_id, 'name', CASE WHEN p.erased_at IS NULL THEN p.name ELSE 'Erased person' END,
                       'organisation', d.organisation, 'status', d.status, 'sent_at', d.sent_at) ORDER BY d.organisation, p.name) FILTER (WHERE d.kind = 'contact'), '[]') AS contacts,
            count(d.id) FILTER (WHERE d.kind = 'subscriber' AND d.status = 'sent')::int AS subscribers_sent,
            count(d.id) FILTER (WHERE d.kind = 'subscriber' AND d.status IN ('pending', 'sending'))::int AS subscribers_pending,
            max(d.sent_at) FILTER (WHERE d.kind = 'subscriber') AS subscribers_last_sent_at
     FROM status_updates su LEFT JOIN status_deliveries d ON d.update_id = su.id LEFT JOIN people p ON p.id = d.person_id
     LEFT JOIN users u ON u.id = su.created_by
     WHERE su.incident_id = $1 GROUP BY su.id, u.display_name ORDER BY su.created_at`,
    [incidentId],
  );
  return rows;
}

// ---- Delivery -------------------------------------------------------------------------------------

const BACKOFF_MINUTES = [1, 5, 30, 120];

function updateLines(title: string, p: NonNullable<Awaited<ReturnType<typeof forOutside>>>['published'], intro: string[]) {
  return [
    ...intro,
    `${cap(p.phase)}: ${p.services.join(', ')}`,
    ...(p.status ? [`Status: ${STATUS_LABEL[p.status] ?? p.status}`] : []),
    '',
    p.message,
    '',
    `${title}, ${new Date(p.published_at).toUTCString()}`,
  ];
}

async function deliver(d: any) {
  const page = await pageSettings();
  if (d.kind === 'confirm') {
    const { rows } = await query(
      `SELECT s.email, (SELECT array_agg(st.public_name ORDER BY st.public_name) FROM service_status st WHERE st.public AND st.ci_id = ANY(s.pending_ci_ids)) AS services
       FROM status_subscribers s WHERE s.id = $1 AND s.pending_ci_ids IS NOT NULL`,
      [d.subscriber_id],
    );
    if (!rows[0]) return 'skipped';
    // Minted when sent and stored as a hash only: a later sign-up's link replaces this one.
    const token = randomBytes(24).toString('base64url');
    await query(`UPDATE status_subscribers SET confirm_hash = $2, confirm_expires_at = now() + $3 * interval '1 hour' WHERE id = $1`, [d.subscriber_id, sha256Hex(token), CONFIRM_HOURS]);
    const what = rows[0].services?.length ? rows[0].services.join(', ') : 'every service on the page';
    await sendOutsideMail(rows[0].email, `Confirm your subscription to ${page.title}`, [
      `Someone asked to receive an email from ${page.title} when there is an update on: ${what}.`,
      '',
      `Confirm: ${absoluteUrl(`/status/confirm?s=${d.subscriber_id}&token=${token}`)}`,
      '',
      `The link works once and expires in ${CONFIRM_HOURS} hours. If this was not you, ignore this message: nothing is sent to you unless the link is confirmed.`,
    ], unsubscribeUrl('s', d.subscriber_id));
    return 'sent';
  }
  const out = await forOutside(null, d.update_id);
  if (!out) return 'skipped';
  const subject = `[${page.title}] ${cap(out.published.phase)}: ${out.published.services.join(', ')}`;
  if (d.kind === 'subscriber') {
    const { rows } = await query('SELECT email FROM status_subscribers WHERE id = $1 AND confirmed_at IS NOT NULL', [d.subscriber_id]);
    if (!rows[0]) return 'skipped';
    await sendOutsideMail(rows[0].email, subject, updateLines(page.title, out.published, []), unsubscribeUrl('s', d.subscriber_id));
    return 'sent';
  }
  const { rows } = await query("SELECT email FROM people WHERE id = $1 AND status_contact AND active AND erased_at IS NULL AND coalesce(email, '') <> ''", [d.person_id]);
  if (!rows[0]) return 'skipped';
  await sendOutsideMail(rows[0].email, subject, updateLines(page.title, out.published, [`You receive this as the contact for ${d.organisation}.`, '']), unsubscribeUrl('p', d.person_id));
  return 'sent';
}

/** Sends due deliveries; claimed with a lease so replicas never send the same one twice. */
export async function processStatusDeliveries(limit = 20) {
  const { rows } = await query(
    `UPDATE status_deliveries d SET status = 'sending', lease_until = now() + interval '2 minutes'
     FROM (SELECT id FROM status_deliveries WHERE (status = 'pending' OR (status = 'sending' AND lease_until < now())) AND next_attempt_at <= now()
           ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED) due
     WHERE d.id = due.id
     RETURNING d.*`,
    [limit],
  );
  let sent = 0;
  for (const d of rows) {
    let error = '';
    let outcome = 'sent';
    try {
      outcome = await deliver(d);
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
    }
    const attempts = d.attempts + 1;
    if (!error) {
      if (outcome === 'sent') sent++;
      await query(`UPDATE status_deliveries SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN now() END, attempts = $3, lease_until = NULL, error = '' WHERE id = $1`, [d.id, outcome, attempts]);
    } else if (attempts > BACKOFF_MINUTES.length || /not configured/.test(error)) {
      await query("UPDATE status_deliveries SET status = 'failed', attempts = $2, error = $3, lease_until = NULL WHERE id = $1", [d.id, attempts, error]);
    } else {
      await query(
        "UPDATE status_deliveries SET status = 'pending', attempts = $2, error = $3, lease_until = NULL, next_attempt_at = now() + $4 * interval '1 minute' WHERE id = $1",
        [d.id, attempts, error, BACKOFF_MINUTES[attempts - 1]],
      );
    }
  }
  return sent;
}

/** Unconfirmed sign-ups go after a week; mail to subscribers is forgotten after 90 days (contacts stay in the log). */
export async function pruneStatusSubscriptions() {
  await query("DELETE FROM status_subscribers WHERE confirmed_at IS NULL AND created_at < now() - interval '7 days'");
  await query("DELETE FROM status_deliveries WHERE kind IN ('confirm', 'subscriber') AND status NOT IN ('pending', 'sending') AND created_at < now() - interval '90 days'");
}

export function startStatusWorker(log: (msg: string) => void) {
  setInterval(() => processStatusDeliveries().catch((err) => log(`status delivery failed: ${err.message}`)), 15_000).unref();
  setInterval(() => pruneStatusSubscriptions().catch((err) => log(`status subscription cleanup failed: ${err.message}`)), 86400_000).unref();
}
