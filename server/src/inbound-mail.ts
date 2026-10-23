// Inbound email (#48). A mailbox connector (connector-mailbox.ts) hands each new message here as raw MIME:
// - new mail becomes an incident; the caller is matched to a person only when the sender is verified;
// - a reply that names an incident (its ref in the subject, or a Message-ID Kernel sent) becomes a comment, but only
//   from a verified sender who takes part in the incident; anything else waits in "Inbound to review";
// - auto-replies, bulk mail, bounces and Kernel's own mail are ignored, each sender is rate-limited per mailbox,
//   and Kernel never answers mail automatically;
// - each Message-ID is handled once per mailbox, so a rerun never creates duplicates.
// The sender is verified only by the receiving server's Authentication-Results (RFC 8601) with the authserv-id the
// mailbox trusts; From alone proves nothing. The body is untrusted text (agents get it as untrusted_content).
import { convert } from 'html-to-text';
import { simpleParser, type ParsedMail } from 'mailparser';
import { z } from 'zod';
import { addAttachment, maxUploadBytes } from './attachments.js';
import { audit } from './audit.js';
import type { User } from './auth.js';
import { contextStore, currentContext } from './context.js';
import { query, tx } from './db.js';
import { badRequest, conflict } from './errors.js';
import { addIncidentComment, createIncident, insertIncident } from './incidents.js';
import { logIncident } from './incident-log.js';
import { logger } from './log.js';
import { notify, ownMail } from './notifications.js';
import { resolvePerson } from './people.js';
import { authorize } from './policy.js';
import { clip } from './core/text.js';
import { sha256Hex } from './core/hash.js';

/** What a mailbox does with new mail; part of the connector's settings. */
export const mailboxTargetSchema = z.object({
  /** The team new incidents go to (its queue and round robin), or none. */
  team_id: z.number().int().nullable().default(null),
  category_id: z.number().int().nullable().default(null),
  impact: z.number().int().min(1).max(3).default(3),
  urgency: z.number().int().min(1).max(3).default(3),
  /**
   * The authserv-id of the receiving mail server's Authentication-Results header (e.g. "mx.example.com", or for
   * Exchange Online the tenant's protection host). Empty: no sender is ever verified.
   */
  trusted_authserv_id: z.string().trim().max(200).default(''),
  /** Messages larger than this are not handled (kept in the mailbox and logged). */
  max_message_mb: z.number().int().min(1).max(50).default(15),
  /** More mail than this from one sender in an hour is ignored. */
  per_sender_per_hour: z.number().int().min(1).max(1000).default(20),
});
export type MailboxTarget = z.infer<typeof mailboxTargetSchema>;

export type Outcome = 'incident' | 'comment' | 'review' | 'ignored' | 'discarded' | 'duplicate';
export interface Handled { outcome: Outcome; reason: string; ref?: string }

const MAX_ATTACHMENTS = 10;
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null; rows: any[] }> };
const domainOf = (address: string) => address.split('@').pop()!.toLowerCase();
const header = (m: ParsedMail, name: string) => {
  const v = m.headers.get(name);
  return v === undefined ? undefined : typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : String((v as { value?: unknown }).value ?? v);
};

/** Why a message is noise that must not create work, or null. */
export function noiseReason(m: ParsedMail, from: string): string | null {
  const auto = header(m, 'auto-submitted');
  if (auto && auto.trim().toLowerCase() !== 'no') return `automatic message (Auto-Submitted: ${clip(auto, 40)})`;
  const precedence = header(m, 'precedence')?.trim().toLowerCase();
  if (precedence && ['bulk', 'junk', 'list'].includes(precedence)) return `bulk mail (Precedence: ${precedence})`;
  if (header(m, 'x-auto-response-suppress') !== undefined) return 'automatic message (X-Auto-Response-Suppress)';
  if (!from) return 'no sender';
  if (/^(mailer-daemon|postmaster)@/i.test(from)) return 'a bounce or postmaster message';
  const own = ownMail();
  if (from === own.address) return "Kernel's own mail";
  if (m.messageId?.toLowerCase().endsWith(`@${own.messageIdDomain}>`)) return "Kernel's own mail";
  return null;
}

/**
 * Whether the receiving server vouched for the From domain: the topmost Authentication-Results header with the
 * trusted authserv-id shows dmarc=pass, or spf/dkim pass aligned with the From domain. Headers from other servers
 * (or added lower down by the sender) are ignored.
 */
export function senderVerified(headerLines: readonly { key: string; line: string }[], fromAddress: string, trusted: string): boolean {
  if (!trusted || !fromAddress.includes('@')) return false;
  const from = domainOf(fromAddress);
  const aligned = (d?: string) => !!d && (d === from || from.endsWith(`.${d}`) || d.endsWith(`.${from}`));
  for (const h of headerLines) {
    if (h.key !== 'authentication-results') continue;
    // Unfold, drop the header name and (comments).
    const value = h.line.replace(/^[^:]*:/, '').replace(/\r?\n[ \t]+/g, ' ').replace(/\([^()]*\)/g, ' ');
    const [id, ...results] = value.split(';').map((s) => s.trim());
    if (id.split(/\s+/)[0]?.toLowerCase() !== trusted.toLowerCase()) continue;
    for (const r of results) {
      const [method, ...props] = r.split(/\s+/);
      const prop = (name: string) => props.find((p) => p.toLowerCase().startsWith(`${name}=`))?.split('=')[1]?.toLowerCase().replace(/^.*@/, '');
      const m = method?.toLowerCase();
      if (m === 'dmarc=pass' && (!prop('header.from') || prop('header.from') === from)) return true;
      if (m === 'spf=pass' && aligned(prop('smtp.mailfrom'))) return true;
      if (m === 'dkim=pass' && aligned(prop('header.d') ?? prop('header.i'))) return true;
    }
    return false; // only the topmost header from the trusted server counts
  }
  return false;
}

/** The new text of a reply: the quoted message below it is cut, and control characters dropped. */
export function newText(text: string) {
  const lines = text.replace(/\r\n/g, '\n').replace(/[^\S\n]+$/gm, '').split('\n');
  const quoteStarts = (i: number) => {
    const l = lines[i].trim();
    if (/^On .+wrote:$/i.test(l) || /^Den .+skrev.*:$/i.test(l) || /^-{2,}\s*(Original Message|Ursprungligt meddelande)\s*-{2,}$/i.test(l) || /^_{10,}$/.test(l)) return true;
    // An Outlook header block: From: followed by Sent/Date/To/Subject.
    return /^(From|Från):\s/i.test(l) && lines.slice(i + 1, i + 5).some((n) => /^(Sent|Date|To|Subject|Skickat|Datum|Till|Ämne):\s/i.test(n.trim()));
  };
  let end = lines.findIndex((_, i) => quoteStarts(i));
  if (end < 0) end = lines.length;
  const kept = lines.slice(0, end);
  while (kept.length && (/^\s*>/.test(kept[kept.length - 1]) || !kept[kept.length - 1].trim())) kept.pop();
  // eslint-disable-next-line no-control-regex
  return kept.join('\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}

/** The incident a reply answers: a Message-ID Kernel sent (In-Reply-To/References), else [INC000123] in the subject. */
async function answeredRef(m: ParsedMail) {
  const ids = [...new Set([...(m.inReplyTo ?? '').split(/\s+/), ...(Array.isArray(m.references) ? m.references : m.references ? [m.references] : [])].filter(Boolean))].slice(0, 50);
  if (ids.length) {
    const { rows } = await query(
      'SELECT n.ref FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE d.message_id = ANY($1) AND n.ref <> \'\' ORDER BY d.id DESC LIMIT 1',
      [ids],
    );
    if (rows[0]) return rows[0].ref as string;
  }
  return m.subject?.match(/\[((?:INC|PRB|CHG)\d{6,})\]/i)?.[1].toUpperCase() ?? '';
}

/** Whether the sender takes part in the incident: its caller or an affected person, its assignee, or its team. */
async function isParticipant(incident: { id: number; caller_id: number | null; assignee_id: number | null; team_id: number | null }, address: string) {
  const { rows } = await query(
    `SELECT 1 FROM people p WHERE lower(p.email) = $2 AND p.erased_at IS NULL
       AND (p.id = $3 OR EXISTS (SELECT 1 FROM incident_people x WHERE x.incident_id = $1 AND x.person_id = p.id))
     UNION ALL
     SELECT 1 FROM users u WHERE lower(u.email) = $2 AND u.active
       AND (u.id = $4 OR EXISTS (SELECT 1 FROM team_members t WHERE t.team_id = $5 AND t.user_id = u.id))
     LIMIT 1`,
    [incident.id, address, incident.caller_id, incident.assignee_id, incident.team_id],
  );
  return !!rows[0];
}

/** Runs fn with the channel "email", so the activity and the audit trail say where it came from. */
const viaEmail = <T>(fn: () => Promise<T>) => contextStore.run({ ...currentContext(), channel: 'email' }, fn);

/**
 * Handles one message from a mailbox. `owner` is the connector's owner: attachments are stored as them. Returns what
 * was done; the mailbox then marks the message handled whatever the outcome (except an error).
 */
export async function receiveMail(mailbox: { id: number; name: string }, owner: User, target: MailboxTarget, raw: Buffer): Promise<Handled> {
  const fallbackId = `<sha256.${sha256Hex(raw)}@${ownMail().messageIdDomain}.inbound>`;
  type Row = Partial<{ from_address: string; from_name: string; subject: string; body: string; verified: boolean; ref: string }>;
  // In the transaction that does the work, when there is one: the mail counts as handled only if the work commits.
  const record = async (messageId: string, row: Row, h: Handled, db: Queryable = { query }) => {
    const { rowCount } = await db.query(
      `INSERT INTO inbound_mail (connector_id, message_id, from_address, from_name, subject, body, verified, outcome, reason, ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (connector_id, message_id) DO NOTHING`,
      [mailbox.id, messageId, row.from_address ?? '', row.from_name ?? '', row.subject ?? '', row.body ?? '', row.verified ?? false, h.outcome, h.reason, row.ref ?? ''],
    );
    return rowCount ? h : { outcome: 'duplicate' as const, reason: 'already handled' };
  };
  if (raw.length > target.max_message_mb * 1024 * 1024) return record(fallbackId, {}, { outcome: 'ignored', reason: `larger than ${target.max_message_mb} MB` });
  const m = await simpleParser(raw, { maxHtmlLengthToParse: 2_000_000 });
  const messageId = clip(m.messageId ?? fallbackId, 500);
  const { rows: seen } = await query('SELECT 1 FROM inbound_mail WHERE connector_id = $1 AND message_id = $2', [mailbox.id, messageId]);
  if (seen[0]) return { outcome: 'duplicate', reason: 'already handled' };
  const sender = m.from?.value[0];
  const from = (sender?.address ?? '').trim().toLowerCase().slice(0, 200);
  const fromName = (sender?.name ?? '').trim().slice(0, 200);
  const subject = clip((m.subject ?? '').trim(), 300);
  const meta = { from_address: from, from_name: fromName, subject };
  const noise = noiseReason(m, from);
  if (noise) return record(messageId, meta, { outcome: 'ignored', reason: noise });
  const { rows: recent } = await query(
    "SELECT count(*)::int AS n FROM inbound_mail WHERE connector_id = $1 AND lower(from_address) = $2 AND received_at > now() - interval '1 hour'",
    [mailbox.id, from],
  );
  if (recent[0].n >= target.per_sender_per_hour) return record(messageId, meta, { outcome: 'ignored', reason: `more than ${target.per_sender_per_hour} messages from this sender in an hour` });

  const verified = senderVerified(m.headerLines ?? [], from, target.trusted_authserv_id);
  const ref = await answeredRef(m);
  // HTML-only mail is turned into plain text (scripts, styles and images dropped); the text part is preferred.
  const plain = m.text?.trim() ? m.text : m.html ? convert(m.html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] }) : '';
  const body = clip(newText(plain), 20_000);
  const attachments = (m.attachments ?? []).filter((a) => a.content?.length);
  const row = { ...meta, verified, ref };
  const held = (reason: string) => record(messageId, { ...row, body }, { outcome: 'review', reason: attachments.length ? `${reason}; ${attachments.length} attachment(s) not kept` : reason, ref });

  if (ref) {
    // A reply: a comment only from a verified participant of an open incident; never silently added otherwise.
    if (!ref.startsWith('INC')) return held(`answers ${ref}, which is not an incident`);
    const { rows } = await query('SELECT id, ref, status, caller_id, assignee_id, team_id, title FROM incidents WHERE ref = $1', [ref]);
    const incident = rows[0];
    if (!incident) return held(`answers ${ref}, which does not exist`);
    if (incident.status === 'closed') return held(`answers ${ref}, which is closed`);
    if (!verified) return held('the sender could not be verified');
    if (!(await isParticipant(incident, from))) return held(`the sender takes no part in ${ref}`);
    if (!body) return held('the reply has no new text');
    const result = await viaEmail(() => tx(async (db) => {
      const h = await record(messageId, row, { outcome: 'comment', reason: '', ref }, db);
      if (h.outcome === 'duplicate') return h;
      const { rows: user } = await db.query('SELECT id FROM users WHERE lower(email) = $1 AND active', [from]);
      const who = fromName ? `${fromName} <${from}>` : from;
      await logIncident(db, incident.id, user[0]?.id ?? null, 'comment', user[0] ? body : `Email from ${who}:\n\n${body}`, { via: 'email' });
      await db.query('UPDATE inbound_mail SET incident_id = $3 WHERE connector_id = $1 AND message_id = $2', [mailbox.id, messageId, incident.id]);
      await notify(db, { users: [incident.assignee_id], event: 'watched_update', ref, title: incident.title, summary: `${who} replied by email.`, path: `/incidents/${ref}`, dedupe: `email:${messageId}`, actorId: user[0]?.id });
      return h;
    }));
    if (result.outcome === 'comment') await keepAttachments(mailbox, owner, ref, incident.id, messageId, attachments);
    return result;
  }

  // New mail: a new incident. An unverified sender is named as reporter only, never matched to a person.
  const created = await viaEmail(() => tx(async (db) => {
    const h = await record(messageId, row, { outcome: 'incident', reason: '' }, db);
    if (h.outcome === 'duplicate') return null;
    const who = fromName ? `${fromName} <${from}>` : from;
    const inc = await insertIncident(db, null, {
      title: subject || '(no subject)', description: body, impact: target.impact, urgency: target.urgency,
      category_id: target.category_id, team_id: target.team_id, reporter: clip(verified ? who : `${who} (unverified sender)`, 200),
    }, [], 'email');
    if (verified) {
      const callerId = await resolvePerson(db, owner, { email: from, name: fromName || undefined });
      await db.query('UPDATE incidents SET caller_id = $2 WHERE id = $1', [inc.id, callerId]);
      await logIncident(db, inc.id, null, 'update', `Caller: person #${callerId} (verified sender)`, { caller: { to: callerId } });
    }
    await db.query('UPDATE inbound_mail SET incident_id = $3, ref = $4 WHERE connector_id = $1 AND message_id = $2', [mailbox.id, messageId, inc.id, inc.ref]);
    return inc;
  }));
  if (!created) return { outcome: 'duplicate', reason: 'already handled' };
  await keepAttachments(mailbox, owner, created.ref, created.id, messageId, attachments);
  return { outcome: 'incident', reason: '', ref: created.ref };
}

/** Attachments go through the attachment service with its limits; what it refuses is noted on the incident. */
async function keepAttachments(mailbox: { id: number }, owner: User, ref: string, incidentId: number, messageId: string, attachments: ParsedMail['attachments']) {
  if (!attachments.length) return;
  const limit = await maxUploadBytes();
  const dropped: string[] = [];
  let kept = 0;
  for (const [i, a] of attachments.entries()) {
    const name = a.filename || `attachment-${i + 1}`;
    if (i >= MAX_ATTACHMENTS) dropped.push(`${name} (more than ${MAX_ATTACHMENTS} attachments)`);
    else if (a.content.length > limit) dropped.push(`${name} (too large)`);
    else {
      try {
        await viaEmail(() => addAttachment(owner, ref, name, a.content));
        kept++;
      } catch (err) {
        dropped.push(`${name} (${(err as Error).message})`);
      }
    }
  }
  await query('UPDATE inbound_mail SET attachments = $3 WHERE connector_id = $1 AND message_id = $2', [mailbox.id, messageId, kept]);
  if (dropped.length) {
    logger.info({ ref, dropped: dropped.length }, 'email attachments not kept');
    await viaEmail(() => tx((db) => logIncident(db, incidentId, null, 'update', `Email attachments not kept: ${clip(dropped.join(', '), 1000)}`, { via: 'email' })));
  }
}

// ---- Inbound to review -------------------------------------------------------------------------

export const inboundDecisionSchema = z.object({
  /** incident: a new incident from the mail; comment: add it to an incident; discard: drop it. */
  action: z.enum(['incident', 'comment', 'discard']),
  /** For comment: the incident (defaults to the one the mail answered). */
  ref: z.string().trim().max(30).optional(),
  reason: z.string().trim().max(1000).optional(),
});

/** Mail that waits for a person: replies that could not be added on their own, with why. */
export async function listInboundMail(user: User) {
  authorize(user, 'incident.update');
  const { rows } = await query(
    `SELECT m.id, m.received_at, m.from_address, m.from_name, m.subject, m.body, m.verified, m.reason, m.ref, c.name AS mailbox
     FROM inbound_mail m LEFT JOIN connectors c ON c.id = m.connector_id WHERE m.outcome = 'review' ORDER BY m.received_at DESC LIMIT 200`,
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/**
 * A person decides what a held mail becomes. It is claimed first, so two people cannot both act on it; its text is
 * cleared once decided (it lives on in the incident, or nowhere).
 */
export async function decideInboundMail(user: User, id: number, input: z.infer<typeof inboundDecisionSchema>) {
  authorize(user, 'incident.update');
  const { rows } = await query(
    "UPDATE inbound_mail SET outcome = 'discarded', decided_by = $2, decided_at = now() WHERE id = $1 AND outcome = 'review' RETURNING *",
    [id, user.id],
  );
  const m = rows[0];
  if (!m) throw conflict('This mail is not waiting for review (any more)');
  const who = m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address;
  try {
    let ref = '';
    if (input.action === 'incident') {
      authorize(user, 'incident.create');
      const created = await createIncident(user, {
        title: m.subject || '(no subject)', description: m.body,
        reporter: m.verified ? who : `${who} (unverified sender)`,
        ...(m.verified && m.from_address ? { caller: { email: m.from_address, name: m.from_name || undefined } } : {}),
      });
      ref = created.ref;
    } else if (input.action === 'comment') {
      ref = (input.ref || m.ref).toUpperCase();
      if (!ref.startsWith('INC')) throw badRequest('Name the incident to add the mail to');
      await addIncidentComment(user, ref, { kind: 'comment', to_requester: false, body: `Email from ${who}${m.verified ? '' : ' (unverified sender)'}:\n\n${m.body}` });
    }
    const { rows: inc } = ref ? await query('SELECT id FROM incidents WHERE ref = $1', [ref]) : { rows: [] as any[] };
    await query("UPDATE inbound_mail SET outcome = $2, incident_id = $3, ref = coalesce(nullif($4, ''), ref), body = '' WHERE id = $1", [id, input.action === 'discard' ? 'discarded' : input.action, inc[0]?.id ?? null, ref]);
    await audit(null, { entity_type: 'inbound_mail', entity_ref: `#${id}`, action: input.action === 'discard' ? 'discarded' : `made_${input.action}`, changes: { ref: ref || undefined }, reason: input.reason });
    return { id, outcome: input.action === 'discard' ? 'discarded' : input.action, ref: ref || null };
  } catch (err) {
    // Nothing happened: back on the list.
    await query("UPDATE inbound_mail SET outcome = 'review', decided_by = NULL, decided_at = NULL WHERE id = $1", [id]);
    throw err;
  }
}
