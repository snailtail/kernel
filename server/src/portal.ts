// The self-service portal (#45): the front door for people outside IT. A portal identity is a person (people), never a
// Kernel user. Its session has its own table and cookie (kernel_portal, path /api/portal) and is only ever read here,
// so it cannot authorise anything else under /api/*. Everything the portal shows comes from audience.ts forPortal.
//
// Sign-in is single sign-on (sso.ts, purpose "portal") or a link by mail: 256 random bits, of which only the SHA-256
// is kept, 15 minutes, single use, minted when the mail is sent. There is no sign-up: the person must already be in
// people. Every answer to a link request is the same, whether the address is known or not.
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forPortal, PORTAL_REOPEN_DAYS } from './audience.js';
import { audit } from './audit.js';
import { config } from './config.js';
import { asSystem, contextStore, currentContext } from './context.js';
import { query, tx } from './db.js';
import { badRequest, conflict, forbidden, HttpError, notFound, unauthorized } from './errors.js';
import { insertIncident } from './incidents.js';
import { logIncident } from './incident-log.js';
import { moduleEnabled } from './modules.js';
import { mailConfigured, notify, sendOutsideMail } from './notifications.js';
import { syncPaging } from './oncall.js';
import type { Db } from './problems.js';
import { rateLimit } from './ratelimit.js';
import { logRequest, runAutomation, submitRequest } from './requests.js';
import { checkSameOrigin } from './security.js';
import { securityEvent } from './security-events.js';
import { slaOnTransition } from './sla.js';
import { signUp as statusSignUp, signUpOpen, unsubscribeUrl } from './status-subscriptions.js';
import { notifyTeamQueue } from './teams.js';
import { absoluteUrl } from './core/url.js';
import { sha256Hex } from './core/hash.js';

export const PORTAL_COOKIE = 'kernel_portal';
const SESSION_HOURS = 8;
const LINK_MINUTES = 15;

export interface PortalPerson { id: number; name: string; email: string | null; organisation_id: number | null }

/** The portal answers only when its module is on; otherwise it does not exist (404). */
export function assertPortalOn() {
  if (!moduleEnabled('portal')) throw notFound('Not found');
}

/**
 * Runs portal work as the person: the audit trail and activity name the portal and the person, and the database does
 * not filter rows (viewer "system"). Every portal query is bound to the person's own records instead.
 */
export const asPortal = <T>(person: PortalPerson, fn: () => T) =>
  contextStore.run({ ...currentContext(), viewer: 'system', userId: null, userName: `person #${person.id}`, actorType: 'portal', channel: 'portal' }, fn);

// ---- Sessions --------------------------------------------------------------------------------------------------

export async function createPortalSession(req: FastifyRequest, reply: FastifyReply, personId: number, method: 'link' | 'sso') {
  const token = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO portal_sessions (token_hash, person_id, method, ip, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5, now() + $6 * interval '1 hour')`,
    [sha256Hex(token), personId, method, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300), SESSION_HOURS],
  );
  await query('DELETE FROM portal_sessions WHERE expires_at < now()');
  reply.setCookie(PORTAL_COOKIE, token, {
    path: '/api/portal', httpOnly: true, sameSite: 'lax', secure: config.secureCookies || req.protocol === 'https', maxAge: SESSION_HOURS * 3600,
  });
  await audit(null, { entity_type: 'portal_session', entity_ref: `person #${personId}`, action: 'login', changes: { method } });
}

/** The signed-in person, or a 401. Changes need the same header and origin as Kernel's own UI (CSRF). */
export async function requirePerson(req: FastifyRequest): Promise<PortalPerson> {
  const token = req.cookies[PORTAL_COOKIE];
  if (!token) throw unauthorized('Not signed in');
  const { rows } = await query(
    `SELECT p.id, p.name, p.email, p.organisation_id FROM portal_sessions s JOIN people p ON p.id = s.person_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND p.active AND p.erased_at IS NULL`,
    [sha256Hex(token)],
  );
  if (!rows[0]) throw unauthorized('Not signed in');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!req.headers['x-kernel-request']) throw forbidden('Missing X-Kernel-Request header');
    checkSameOrigin(req);
  }
  return rows[0];
}

export async function endPortalSession(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[PORTAL_COOKIE];
  if (token) await query('DELETE FROM portal_sessions WHERE token_hash = $1', [sha256Hex(token)]);
  reply.clearCookie(PORTAL_COOKIE, { path: '/api/portal' });
  return { ok: true };
}

/** What the sign-in page offers (nothing secret): single sign-on if it is set up, email links if mail is. */
export async function signInOptions() {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'sso'");
  return { sso: rows[0]?.value?.enabled === true, email: mailConfigured() };
}

// ---- Sign-in by link -------------------------------------------------------------------------------------------

export const linkRequestSchema = z.object({ email: z.string().trim().toLowerCase().max(254).pipe(z.email()) });

/** The one answer to every link request, so nobody learns which addresses are known. */
export const LINK_SENT = 'If this address belongs to someone we help, a sign-in link is on its way. It works once, for 15 minutes.';

export async function requestLink(req: FastifyRequest, input: z.infer<typeof linkRequestSchema>) {
  if (!mailConfigured()) throw new HttpError(503, 'Sign-in by email is not available here. Use single sign-on, or contact your service desk.');
  rateLimit(`portal-link:ip:${req.ip}`, 20, 3600_000);
  // Per address, quietly: beyond the limit the answer is the same and nothing is sent, so nobody can flood an inbox.
  try {
    rateLimit(`portal-link:to:${sha256Hex(input.email)}`, 5, 3600_000);
  } catch {
    securityEvent({ action: 'portal.link_limited', category: 'authentication', outcome: 'denied', message: 'Portal sign-in links to one address limited' }, req);
    return { message: LINK_SENT };
  }
  const { rows } = await query("SELECT id FROM people WHERE lower(email) = $1 AND active AND erased_at IS NULL AND coalesce(email, '') <> ''", [input.email]);
  if (!rows[0]) {
    securityEvent({ action: 'portal.link_unknown', category: 'authentication', outcome: 'failure', message: 'Portal sign-in link asked for an unknown address' }, req);
    return { message: LINK_SENT };
  }
  // Sign-in mail belongs to no record, so only the system sees it (portal_mail's row-level rule).
  await asSystem(() => query("INSERT INTO portal_mail (kind, person_id) VALUES ('signin', $1)", [rows[0].id]));
  return { message: LINK_SENT };
}

export const linkSignInSchema = z.object({ token: z.string().min(20).max(100) });

/** Signs in with a link (POST only: mail scanners open every link with GET). Single use. */
export async function signInWithLink(req: FastifyRequest, reply: FastifyReply, token: string) {
  rateLimit(`portal-signin:ip:${req.ip}`, 30, 3600_000);
  const { rows } = await query(
    `UPDATE portal_links l SET used_at = now() FROM people p
     WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.expires_at > now() AND p.id = l.person_id AND p.active AND p.erased_at IS NULL
     RETURNING l.person_id`,
    [sha256Hex(token)],
  );
  if (!rows[0]) {
    securityEvent({ action: 'portal.link_refused', category: 'authentication', outcome: 'failure', message: 'Portal sign-in link expired, used or unknown' }, req);
    throw badRequest('This link has expired or was already used. Ask for a new one.');
  }
  await createPortalSession(req, reply, rows[0].person_id, 'link');
  return { ok: true };
}

// ---- What the person sees --------------------------------------------------------------------------------------

export async function me(person: PortalPerson) {
  return { name: person.name, report_problem: moduleEnabled('incident'), requests: moduleEnabled('request'), status: (await serviceStatus(person)).services.length > 0 };
}

export const myTickets = (person: PortalPerson) => forPortal(null, person.id);

export async function ticket(person: PortalPerson, ref: string) {
  const [t] = await forPortal(null, person.id, ref);
  if (!t) throw notFound('Not found');
  return t;
}

/**
 * How a service is named for people outside IT: its public name, else the catalogue's own name. An internal service
 * with neither has no such name and is left out. (configuration_items c, service_status st joined on public.)
 */
const PORTAL_NAME = "coalesce(nullif(st.public_name, ''), CASE WHEN c.in_catalogue THEN c.name END)";

/** Services the person can choose when reporting: their organisation's services and the service catalogue. */
export async function services(person: PortalPerson) {
  const { rows } = await query(
    `SELECT c.ref, ${PORTAL_NAME} AS name FROM configuration_items c
     LEFT JOIN service_status st ON st.ci_id = c.id AND st.public
     WHERE c.class = 'service' AND c.status <> 'retired'
       AND (c.in_catalogue OR EXISTS (SELECT 1 FROM organisation_services os WHERE os.ci_id = c.id AND os.organisation_id = $1))
       AND ${PORTAL_NAME} IS NOT NULL
     ORDER BY 2 LIMIT 200`,
    [person.organisation_id ?? 0],
  );
  return rows;
}

/** Help articles written for end users, suggested while the person describes the problem. */
export async function suggest(text: string) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  if (!words.length || !moduleEnabled('knowledge')) return [];
  const { rows } = await query(
    `SELECT a.ref, a.title FROM articles a, to_tsquery('simple', $1) q
     WHERE a.status = 'published' AND a.audience = 'end_users' AND a.search @@ q ORDER BY ts_rank(a.search, q) DESC LIMIT 5`,
    [[...new Set(words)].slice(0, 12).map((w) => `${w}:*`).join(' | ')],
  );
  return rows;
}

export async function article(ref: string) {
  if (!moduleEnabled('knowledge')) throw notFound('Not found');
  const { rows } = await query("SELECT ref, title, body, updated_at FROM articles WHERE ref = $1 AND status = 'published' AND audience = 'end_users'", [ref.toUpperCase()]);
  if (!rows[0]) throw notFound('Not found');
  return rows[0];
}

// ---- Reporting a problem ---------------------------------------------------------------------------------------

/** How many are affected decides impact and urgency through this fixed mapping; the person never picks a priority. */
export const AFFECTED = {
  me: { impact: 3, urgency: 2, label: 'Just me' },
  some: { impact: 2, urgency: 2, label: 'Me and some others' },
  many: { impact: 1, urgency: 2, label: 'Many people, or everyone' },
} as const;

export const reportSchema = z.object({
  service: z.string().trim().max(30).nullable().default(null),
  what: z.string().trim().min(5, 'Tell us a little more about what is happening').max(5000),
  affected: z.enum(['me', 'some', 'many']),
});

const titleFrom = (text: string) => {
  const first = text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? text.trim();
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
};

export async function reportProblem(person: PortalPerson, input: z.infer<typeof reportSchema>) {
  if (!moduleEnabled('incident')) throw notFound('Not found');
  let ciIds: number[] = [];
  if (input.service) {
    const allowed = await services(person);
    if (!allowed.some((s) => s.ref === input.service!.toUpperCase())) throw badRequest('Choose a service from the list');
    const { rows } = await query('SELECT id FROM configuration_items WHERE ref = $1', [input.service.toUpperCase()]);
    ciIds = rows.map((r) => r.id);
  }
  const { impact, urgency } = AFFECTED[input.affected];
  const created = await tx(async (db) => {
    const inc = await insertIncident(db, null, { title: titleFrom(input.what), description: input.what, impact, urgency, reporter: '' }, ciIds, 'portal');
    await db.query('UPDATE incidents SET caller_id = $2 WHERE id = $1', [inc.id, person.id]);
    await logIncident(db, inc.id, null, 'update', `Reported in the portal by person #${person.id}`, { caller: { to: person.id }, via: 'portal', affected: input.affected });
    return inc;
  });
  return ticket(person, created.ref);
}

// ---- Adding information, confirming ----------------------------------------------------------------------------

export const messageSchema = z.object({ body: z.string().trim().min(1, 'Write something first').max(5000) });

type Own = { kind: 'incident' | 'request'; id: number; ref: string; title: string; status: string; team_id: number | null; assignee_id: number | null };

async function own(db: Db, person: PortalPerson, ref: string): Promise<Own> {
  const r = ref.toUpperCase();
  const { rows } = await db.query(
    `SELECT 'incident' AS kind, id, ref, title, status, team_id, assignee_id FROM incidents WHERE ref = $1 AND caller_id = $2
     UNION ALL SELECT 'request', id, ref, title, status, NULL, NULL FROM requests WHERE ref = $1 AND requester_id = $2`,
    [r, person.id],
  );
  if (!rows[0]) throw notFound('Not found');
  // Lock the row, so a reopen and a staff change cannot interleave.
  await db.query(`SELECT 1 FROM ${rows[0].kind === 'incident' ? 'incidents' : 'requests'} WHERE id = $1 FOR UPDATE`, [rows[0].id]);
  return rows[0];
}

/** Tells the people handling it: the assignee, or the team's queue. Titles stay inside Kernel. */
async function tellHandlers(db: Db, t: Own, summary: string) {
  const path = `/${t.kind === 'incident' ? 'incidents' : 'requests'}/${t.ref}`;
  if (t.assignee_id) await notify(db, { users: [t.assignee_id], event: 'watched_update', ref: t.ref, title: t.title, summary, path, dedupe: `portal:${t.ref}:${Date.now()}`, actorId: null });
  else if (t.team_id) await notifyTeamQueue(db, t.team_id, { ref: t.ref, title: t.title, path }, null);
  if (t.kind === 'request') {
    const { rows } = await db.query("SELECT DISTINCT team_id FROM request_tasks WHERE request_id = $1 AND status = 'open' AND team_id IS NOT NULL", [t.id]);
    for (const r of rows) await notify(db, { users: (await db.query('SELECT user_id FROM team_members WHERE team_id = $1', [r.team_id])).rows.map((m) => m.user_id), event: 'watched_update', ref: t.ref, title: t.title, summary, path, dedupe: `portal:${t.ref}:${r.team_id}:${Date.now()}`, actorId: null });
  }
}

/** "Add information": the person's message becomes a comment marked as theirs (untrusted text for agents). */
export async function addInformation(person: PortalPerson, ref: string, body: string) {
  await tx(async (db) => {
    const t = await own(db, person, ref);
    const [view] = await forPortal(db, person.id, t.ref);
    if (!view.can.add_information) throw conflict('This is closed. If you still need help, report it again.');
    const data = { from_requester: true, person_id: person.id };
    if (t.kind === 'incident') await logIncident(db, t.id, null, 'comment', body, data);
    else await logRequest(db, t.id, null, 'comment', body, data);
    await tellHandlers(db, t, 'The requester added information in the portal.');
  });
  return ticket(person, ref);
}

export const confirmSchema = z.object({ works: z.boolean(), body: z.string().trim().max(5000).default('') });

/**
 * On a solved problem report: "It works" closes it, "Still a problem" reopens it (within PORTAL_REOPEN_DAYS of being
 * solved). A major incident only records the answer: it closes through its review.
 */
export async function confirm(person: PortalPerson, ref: string, input: z.infer<typeof confirmSchema>) {
  await tx(async (db) => {
    const t = await own(db, person, ref);
    const [view] = await forPortal(db, person.id, t.ref);
    if (t.kind !== 'incident' || !view.can.confirm) throw conflict(`This can no longer be confirmed. If you still need help, report it again (it was solved more than ${PORTAL_REOPEN_DAYS} days ago or is closed).`);
    if (input.body) await logIncident(db, t.id, null, 'comment', input.body, { from_requester: true, person_id: person.id });
    const { rows } = await db.query('SELECT is_major FROM incidents WHERE id = $1', [t.id]);
    if (input.works) {
      if (rows[0].is_major) {
        await logIncident(db, t.id, null, 'update', 'The caller confirmed in the portal that it works', { by_requester: true, confirmed: true });
        return;
      }
      await db.query("UPDATE incidents SET status = 'closed', closed_at = now() WHERE id = $1", [t.id]);
      await slaOnTransition(db, t.id, 'closed');
      await logIncident(db, t.id, null, 'status', 'The caller confirmed in the portal that it works', { from: 'resolved', to: 'closed', by_requester: true });
    } else {
      await db.query("UPDATE incidents SET status = 'in_progress', resolved_at = NULL, closed_at = NULL, reopen_count = reopen_count + 1 WHERE id = $1", [t.id]);
      await slaOnTransition(db, t.id, 'in_progress');
      if (rows[0].is_major) await db.query("UPDATE incidents SET major_next_update_at = now() + coalesce(major_update_minutes, 60) * interval '1 minute', major_overdue_notified_for = NULL WHERE id = $1", [t.id]);
      await logIncident(db, t.id, null, 'status', 'The caller says it is still a problem (portal)', { from: 'resolved', to: 'in_progress', by_requester: true });
      await syncPaging(db, t.id, null);
      await tellHandlers(db, t, 'The caller says it is still a problem: reopened from the portal.');
    }
  });
  return ticket(person, ref);
}

// ---- Asking for something (part 2) ----------------------------------------------------------------------------

// Fields people outside IT can answer. A person or CI field would need Kernel's directory or CMDB: such items are
// ordered inside Kernel instead.
const PORTAL_FIELDS = ['text', 'textarea', 'choice', 'date'];

async function catalogueRows(itemId: number | null) {
  if (!moduleEnabled('request')) throw notFound('Not found');
  const { rows } = await query(
    `SELECT i.id, i.name, i.description, i.form, i.approval <> 'none' AS needs_approval, ${PORTAL_NAME} AS service
     FROM request_items i JOIN configuration_items c ON c.id = i.service_id LEFT JOIN service_status st ON st.ci_id = c.id AND st.public
     WHERE i.active AND ($1::int IS NULL OR i.id = $1)
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.form) f WHERE NOT (f->>'type' = ANY($2)))
     ORDER BY 6 NULLS LAST, i.name LIMIT 300`,
    [itemId, PORTAL_FIELDS],
  );
  return rows.map(({ form, ...i }) => ({ ...i, form: (form as any[]).map((f) => ({ key: f.key, label: f.label, type: f.type, required: !!f.required, choices: f.choices ?? [] })) }));
}

/** The catalogue as the person sees it: what they can ask for, grouped by the service's name for them. */
export const catalogue = async () => (await catalogueRows(null)).map(({ form: _form, ...i }) => i);

export async function catalogueItem(id: number) {
  const [item] = await catalogueRows(id);
  if (!item) throw notFound('Not found');
  return item;
}

export const orderSchema = z.object({ item_id: z.number().int(), answers: z.record(z.string(), z.unknown()).default({}) });

/**
 * The person asks for something: the same form check and flow as inside Kernel (submitRequest), with the person as
 * the requester and no Kernel user as the one who logged it.
 */
export async function order(person: PortalPerson, input: z.infer<typeof orderSchema>) {
  await catalogueItem(input.item_id);
  const ref = await tx(async (db) => {
    const { rows } = await db.query('SELECT id, name, user_id FROM people WHERE id = $1', [person.id]);
    return submitRequest(db, input.item_id, rows[0], input.answers, { loggerId: null });
  });
  await runAutomation(ref);
  return ticket(person, ref);
}

// ---- Service status (part 2) -----------------------------------------------------------------------------------

/**
 * The status of the services the person's organisation uses, as the status page publishes them (#46): public names,
 * the published status and published, unretracted updates of the last 14 days. Nothing else about the services.
 */
export async function serviceStatus(person: PortalPerson) {
  const { rows: services } = await query(
    `SELECT st.ci_id, st.public_name AS name, st.public_description AS description, st.public_status AS status
     FROM service_status st JOIN organisation_services os ON os.ci_id = st.ci_id AND os.organisation_id = $1
     WHERE st.public AND coalesce(st.public_name, '') <> '' ORDER BY st.public_name`,
    [person.organisation_id ?? 0],
  );
  const ids = services.map((s) => s.ci_id);
  const { rows: updates } = ids.length ? await query(
    `SELECT su.phase, su.status, su.message, su.created_at,
            (SELECT array_agg(st.public_name ORDER BY st.public_name) FROM service_status st WHERE st.public AND st.ci_id = ANY(su.ci_ids) AND st.ci_id = ANY($1)) AS services
     FROM status_updates su WHERE su.public AND su.retracted_at IS NULL AND su.ci_ids && $1 AND su.created_at > now() - interval '14 days'
     ORDER BY su.created_at DESC LIMIT 20`,
    [ids],
  ) : { rows: [] as any[] };
  return {
    services: services.map(({ ci_id: _id, ...s }) => s),
    updates: updates.filter((u) => u.services?.length).map((u) => ({ ...u, created_at: new Date(u.created_at).toISOString() })),
    sign_up: services.length > 0 && !!person.email && (await signUpOpen()),
  };
}

/** Email about these services (#46's sign-up): the person's own address, confirmed by mail like every sign-up. */
export async function subscribe(person: PortalPerson, ip: string) {
  const { services: mine, sign_up } = await serviceStatus(person);
  if (!sign_up) throw notFound('Not found');
  return statusSignUp({ email: person.email!, services: mine.map((s) => s.name) }, ip);
}

// ---- How did it go (part 2) ------------------------------------------------------------------------------------

export const RATINGS = { good: 'Good', okay: 'Okay', bad: 'Not good' } as const;
export const rateSchema = z.object({ rating: z.enum(['good', 'okay', 'bad']), comment: z.string().trim().max(2000).default('') });

/** One click once it is closed, once per ticket. The rating and any comment go into the record's history too. */
export async function rate(person: PortalPerson, ref: string, input: z.infer<typeof rateSchema>) {
  await tx(async (db) => {
    const t = await own(db, person, ref);
    const [view] = await forPortal(db, person.id, t.ref);
    if (!view.can.rate) throw conflict(view.rating ? 'You have already told us. Thank you.' : 'You can tell us how it went once it is closed.');
    await db.query(`INSERT INTO portal_feedback (person_id, ${t.kind}_id, rating, comment) VALUES ($1, $2, $3, $4)`, [person.id, t.id, input.rating, input.comment]);
    const log = t.kind === 'incident' ? logIncident : logRequest;
    await log(db, t.id, null, 'update', `Rated in the portal: ${RATINGS[input.rating]}`, { rating: input.rating, by_requester: true });
    if (input.comment) await log(db, t.id, null, 'comment', input.comment, { from_requester: true, person_id: person.id, rating: input.rating });
  });
  return ticket(person, ref);
}

// ---- Replies to the requester (staff side) ---------------------------------------------------------------------

/**
 * Queues mail for a reply to the requester on an incident (its caller) or a request (its requester), in the reply's
 * transaction. Nothing goes to someone who unsubscribed, has no email, or is no longer active.
 */
export async function queueReply(db: Db, kind: 'incident' | 'request', recordId: number) {
  // The portal shows a confidential record, or a restricted problem report, as its ref and status only (forPortal),
  // so a reply would never be read. A restricted request is the requester's own and is shown.
  const { rows: rec } = await db.query(`SELECT ref, ${kind === 'incident' ? 'restricted OR ' : ''}classification = 'confidential' AS narrow FROM ${kind}s WHERE id = $1`, [recordId]);
  if (rec[0]?.narrow) throw badRequest(`${rec[0].ref} is restricted or confidential, so the requester sees only its status: contact them directly instead`);
  const { rows } = await db.query(
    kind === 'incident'
      ? `SELECT p.id, (SELECT max(a.id) FROM incident_activity a WHERE a.incident_id = i.id AND a.kind = 'comment') AS activity_id
         FROM incidents i JOIN people p ON p.id = i.caller_id WHERE i.id = $1 AND p.request_mail AND p.active AND p.erased_at IS NULL AND coalesce(p.email, '') <> ''`
      : `SELECT p.id, (SELECT max(a.id) FROM request_activity a WHERE a.request_id = r.id AND a.kind = 'comment') AS activity_id
         FROM requests r JOIN people p ON p.id = r.requester_id WHERE r.id = $1 AND p.request_mail AND p.active AND p.erased_at IS NULL AND coalesce(p.email, '') <> ''`,
    [recordId],
  );
  if (!rows[0]) return false;
  await db.query(`INSERT INTO portal_mail (kind, person_id, ${kind}_id, activity_id) VALUES ('reply', $1, $2, $3)`, [rows[0].id, recordId, rows[0].activity_id]);
  return true;
}

// ---- Delivery --------------------------------------------------------------------------------------------------

async function deliver(m: any) {
  const { rows: p } = await query("SELECT email, request_mail FROM people WHERE id = $1 AND active AND erased_at IS NULL AND coalesce(email, '') <> ''", [m.person_id]);
  if (!p[0]) return 'skipped';
  if (m.kind === 'signin') {
    // Minted when sent, hash only; an earlier unused link for the person stops working.
    const token = randomBytes(32).toString('base64url');
    await query('UPDATE portal_links SET used_at = now() WHERE person_id = $1 AND used_at IS NULL', [m.person_id]);
    await query(`INSERT INTO portal_links (person_id, token_hash, expires_at) VALUES ($1, $2, now() + $3 * interval '1 minute')`, [m.person_id, sha256Hex(token), LINK_MINUTES]);
    await sendOutsideMail(p[0].email, 'Your sign-in link', [
      'Someone asked to sign in to the help portal with this address.',
      '',
      `Sign in: ${absoluteUrl(`/portal/signin?token=${token}`)}`,
      '',
      `The link works once and expires in ${LINK_MINUTES} minutes. If this was not you, ignore this message.`,
    ], null);
    return 'sent';
  }
  if (!p[0].request_mail) return 'skipped';
  const table = m.incident_id ? 'incidents' : 'requests';
  const { rows: rec } = await query(`SELECT ref FROM ${table} WHERE id = $1`, [m.incident_id ?? m.request_id]);
  if (!rec[0]) return 'skipped';
  const [t] = await forPortal(null, m.person_id, rec[0].ref);
  if (!t) return 'skipped';
  // The reply itself goes along, unless the record is restricted or confidential (then only that there is one).
  const { rows: reply } = t.title && m.activity_id
    ? await query(`SELECT body FROM ${m.incident_id ? 'incident_activity' : 'request_activity'} WHERE id = $1 AND data->>'for_requester' = 'true'`, [m.activity_id])
    : { rows: [] as any[] };
  const what = t.title ? `"${t.title}" (${t.ref})` : t.ref;
  await sendOutsideMail(p[0].email, `Reply on ${t.ref}`, [
    `There is a reply from ${t.handled_by} on ${what}.`,
    ...(reply[0] ? ['', reply[0].body] : []),
    '',
    `Read it and answer: ${absoluteUrl(`/portal/tickets/${t.ref}`)}`,
  ], unsubscribeUrl('r', m.person_id));
  return 'sent';
}

/** Sends due portal mail; claimed with a lease so replicas never send the same one twice. */
export async function processPortalMail(limit = 20) {
  const { rows } = await query(
    `UPDATE portal_mail m SET status = 'sending', lease_until = now() + interval '2 minutes'
     FROM (SELECT id FROM portal_mail WHERE (status = 'pending' OR (status = 'sending' AND lease_until < now())) AND next_attempt_at <= now()
           ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED) due
     WHERE m.id = due.id RETURNING m.*`,
    [limit],
  );
  let sent = 0;
  for (const m of rows) {
    let error = '';
    let outcome = 'sent';
    try {
      outcome = await deliver(m);
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
    }
    const attempts = m.attempts + 1;
    // A sign-in link is only useful now: it is not retried for long.
    const maxAttempts = m.kind === 'signin' ? 2 : 5;
    if (!error) {
      if (outcome === 'sent') sent++;
      await query("UPDATE portal_mail SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN now() END, attempts = $3, lease_until = NULL, error = '' WHERE id = $1", [m.id, outcome, attempts]);
    } else if (attempts >= maxAttempts || /not configured/.test(error)) {
      await query("UPDATE portal_mail SET status = 'failed', attempts = $2, error = $3, lease_until = NULL WHERE id = $1", [m.id, attempts, error]);
    } else {
      await query("UPDATE portal_mail SET status = 'pending', attempts = $2, error = $3, lease_until = NULL, next_attempt_at = now() + $4 * interval '1 minute' WHERE id = $1", [m.id, attempts, error, 2 ** attempts]);
    }
  }
  return sent;
}

/** Spent links and old portal mail go; sessions expire on their own and are cleared at the next sign-in. */
export async function prunePortal() {
  await query("DELETE FROM portal_links WHERE expires_at < now() - interval '1 day'");
  await query("DELETE FROM portal_mail WHERE kind = 'signin' AND status NOT IN ('pending', 'sending') AND created_at < now() - interval '1 day'");
  await query("DELETE FROM portal_mail WHERE status NOT IN ('pending', 'sending') AND created_at < now() - interval '90 days'");
}

export function startPortalWorker(log: (msg: string) => void) {
  setInterval(() => moduleEnabled('portal') && asSystem(() => processPortalMail()).catch((err) => log(`portal mail failed: ${err.message}`)), 10_000).unref();
  setInterval(() => asSystem(() => prunePortal()).catch((err) => log(`portal cleanup failed: ${err.message}`)), 3600_000).unref();
}
