// Notifications for people (#48). Every notification lands in the in-app notification centre; email (instant or a
// daily digest) and a personal chat webhook are opt-in per event with quiet defaults. Each event reaches each person
// once (dedupe key), the actor is never notified of their own action, and content is minimal: ref, title, one line,
// a link. Deliveries are an outbox processed after commit, with retries.
import type { ApprovalLinks } from './approval-links.js';
import { activeKey, keyring } from './keys.js';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { z } from 'zod';
import type { User } from './auth.js';
import { config } from './config.js';
import { currentBulk, type BulkContext } from './context.js';
import { type Db, query, tx } from './db.js';
import { badRequest } from './errors.js';
import { localDate, zonedToUtc } from './business-time.js';
import { checkUrl, outboundFetch } from './outbound.js';
import { decryptSecret, encryptSecret } from './secrets.js';
import { formatBody } from './webhooks.js';
import { absoluteUrl } from './core/url.js';
import { clip } from './core/text.js';
import { backoffMinutes, processOutbox } from './core/outbox.js';

/** The events people can be notified about, with quiet defaults per channel. */
export const EVENTS = {
  assigned: { label: 'Something is assigned to me', email: true, chat: true },
  account_security: { label: 'My account was locked or signed in from a new device', email: true, chat: false },
  security_alert: { label: 'A security alert: failed sign-ins, probing, a new administrator, changed credentials (administrators)', email: true, chat: true },
  team_queue: { label: "New work in my team's queue (no one assigned yet)", email: false, chat: true },
  approval_needed: { label: 'Something waits for my approval', email: true, chat: true },
  decision: { label: 'A decision on something I requested', email: true, chat: false },
  sla_breach: { label: 'An SLA is breached on my incident', email: true, chat: true },
  sla_warning: { label: 'An SLA is at risk on my incident', email: false, chat: true },
  major_incident: { label: 'A major incident is declared', email: true, chat: true },
  paged: { label: 'I am paged as the on-call person (built-in rotation), or a page for my team failed', email: true, chat: true },
  major_update_due: { label: 'A stakeholder update I am responsible for is overdue', email: false, chat: true },
  watched_update: { label: 'An update on something I watch', email: false, chat: false },
  service_status: { label: 'A status update on a service I follow', email: true, chat: true },
  automation: { label: 'An automation rule tells me about a record, or a rule I own was turned off by its safety limit', email: false, chat: true },
} as const;
export type NotificationEvent = keyof typeof EVENTS;


export interface Notice {
  users: (number | null | undefined)[];
  event: NotificationEvent;
  ref: string;
  title: string;
  summary: string;
  /** Path in the web UI, e.g. /incidents/INC000012. */
  path: string;
  /** Unique per event for a user, e.g. "sla_breach:INC000012:resolution". */
  dedupe: string;
  /** Who caused it; never notified about their own action. */
  actorId?: number | null;
  /** For approval_needed from an MCP request: the request, so email and chat can carry approval links. */
  approvalId?: number;
}

/** Records notifications (in the caller's transaction) and queues their deliveries. */
export async function notify(db: Db, n: Notice) {
  const users = [...new Set(n.users.filter((u): u is number => !!u && u !== n.actorId))];
  if (!users.length) return 0;
  // In a bulk request (#125) notices wait for the end of it, and then go as one per person and event.
  const bulk = currentBulk();
  if (bulk) {
    bulk.staged.push({ ...n, users });
    return users.length;
  }
  // Only people who may see the record hear about it (#53): a restricted record's title never reaches others.
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, event, ref, title, summary, url, dedupe_key, approval_id)
     SELECT u, $2, $3, $4, $5, $6, $7, $8 FROM unnest($1::int[]) AS u
     JOIN users ON users.id = u AND users.active
     WHERE kernel_user_can_see(u, $3)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING
     RETURNING id, user_id`,
    [users, n.event, n.ref, clip(n.title, 200), clip(n.summary, 200), n.path, n.dedupe, n.approvalId ?? null],
  );
  if (!rows.length) return 0;
  const { rows: settings } = await db.query(
    `SELECT u.id, u.email AS address, s.email, s.digest, s.events, s.chat_url IS NOT NULL AS has_chat
     FROM users u LEFT JOIN notification_settings s ON s.user_id = u.id WHERE u.id = ANY($1)`,
    [rows.map((r) => r.user_id)],
  );
  const byUser = new Map(settings.map((s) => [s.id as number, s]));
  for (const r of rows) {
    const s = byUser.get(r.user_id);
    const wants = (channel: 'email' | 'chat') => s?.events?.[n.event]?.[channel] ?? EVENTS[n.event][channel];
    if (s?.address && (s.email ?? true) && !s.digest && wants('email')) {
      await db.query("INSERT INTO notification_deliveries (notification_id, user_id, channel) VALUES ($1, $2, 'email')", [r.id, r.user_id]);
    }
    if (s?.has_chat && wants('chat')) {
      await db.query("INSERT INTO notification_deliveries (notification_id, user_id, channel) VALUES ($1, $2, 'chat')", [r.id, r.user_id]);
    }
  }
  return rows.length;
}

/**
 * Sends what a bulk request held back: a person who would get one notice gets it as it was; a person who would get
 * several for the same event gets one that counts them and links to the list of the records the request changed.
 * Only records the person may see are counted.
 */
export async function flushBulkNotices(b: BulkContext) {
  b.done = true;
  const groups = new Map<string, { user: number; event: NotificationEvent; notices: Notice[] }>();
  for (const n of b.notices) {
    for (const u of n.users) {
      const key = `${u}:${n.event}`;
      const g = groups.get(key) ?? { user: u as number, event: n.event, notices: [] };
      g.notices.push(n);
      groups.set(key, g);
    }
  }
  if (!groups.size) return;
  const many = b.practice === 'cis' ? 'CIs' : b.practice;
  await tx(async (db) => {
    for (const g of groups.values()) {
      const refs = [...new Set(g.notices.map((n) => n.ref))];
      const { rows } = await db.query('SELECT r FROM unnest($2::text[]) r WHERE kernel_user_can_see($1, r)', [g.user, refs]);
      const seen = new Set(rows.map((r) => r.r));
      const notices = g.notices.filter((n) => seen.has(n.ref));
      if (notices.length <= 1) {
        for (const n of notices) await notify(db, { ...n, users: [g.user] });
        continue;
      }
      const count = `${notices.length} ${many}`;
      const summary = g.event === 'assigned' ? `${b.actor.name} assigned ${count} to you.`
        : g.event === 'team_queue' ? `${count} came into your team's queue, from a change by ${b.actor.name}.`
        : `${b.actor.name} changed ${count} at once: ${EVENTS[g.event].label.toLowerCase()}.`;
      await notify(db, {
        users: [g.user], event: g.event, ref: '', title: count, summary, path: `/${b.practice}?bulk=${b.id}&status=all`,
        dedupe: `bulk:${b.id}:${g.event}`, actorId: b.actor.id,
      });
    }
  });
}

/** Active managers and administrators (the change authority, and who hears about major incidents). */
export async function managers(db: Db, exclude: (number | null | undefined)[] = []) {
  const { rows } = await db.query("SELECT id FROM users WHERE active AND role IN ('admin', 'manager') AND NOT (id = ANY($1))", [exclude.filter(Boolean)]);
  return rows.map((r) => r.id as number);
}

// ---- Reading and settings ----------------------------------------------------------------------

export async function listNotifications(user: User, unreadOnly: boolean, limit = 50) {
  const { rows } = await query(
    `SELECT id, event, ref, title, summary, url, created_at, read_at FROM notifications
     WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT $2`,
    [user.id, limit],
  );
  const { rows: count } = await query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [user.id]);
  return { unread: count[0].n, notifications: rows };
}

export async function markRead(user: User, ids: number[] | 'all') {
  if (ids === 'all') await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.id]);
  else await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL', [user.id, ids]);
  return listNotifications(user, false, 50);
}

export const settingsSchema = z.object({
  email: z.boolean().optional(),
  digest: z.boolean().optional(),
  events: z.partialRecord(z.enum(Object.keys(EVENTS) as [NotificationEvent, ...NotificationEvent[]]), z.object({ email: z.boolean().optional(), chat: z.boolean().optional() })).optional(),
  /** A personal Slack or Teams workflow webhook; empty string removes it. */
  chat_url: z.string().trim().max(2000).optional(),
  chat_format: z.enum(['slack', 'teams_workflow']).optional(),
});

export async function getSettings(user: User) {
  const { rows } = await query('SELECT email, digest, events, chat_url IS NOT NULL AS has_chat, chat_format FROM notification_settings WHERE user_id = $1', [user.id]);
  const s = rows[0] ?? { email: true, digest: false, events: {}, has_chat: false, chat_format: 'slack' };
  return {
    ...s,
    address: user.email || null,
    email_configured: !!process.env.SMTP_URL,
    events: Object.fromEntries(Object.entries(EVENTS).map(([k, d]) => [k, { label: d.label, email: s.events[k]?.email ?? d.email, chat: s.events[k]?.chat ?? d.chat }])),
  };
}

export async function saveSettings(user: User, input: z.infer<typeof settingsSchema>) {
  if (input.chat_url) {
    const problem = checkUrl(input.chat_url);
    if (problem || !input.chat_url.startsWith('https://')) throw badRequest(problem ?? 'The chat webhook must use https');
  }
  const { rows } = await query('SELECT events FROM notification_settings WHERE user_id = $1', [user.id]);
  const events = { ...(rows[0]?.events ?? {}), ...(input.events ?? {}) };
  await query(
    `INSERT INTO notification_settings (user_id, email, digest, events, chat_url, chat_format) VALUES ($1, coalesce($2, true), coalesce($3, false), $4, $5, coalesce($6, 'slack'))
     ON CONFLICT (user_id) DO UPDATE SET email = coalesce($2, notification_settings.email), digest = coalesce($3, notification_settings.digest), events = $4,
       chat_url = CASE WHEN $7 THEN $5 ELSE notification_settings.chat_url END, chat_format = coalesce($6, notification_settings.chat_format), updated_at = now()`,
    [user.id, input.email ?? null, input.digest ?? null, JSON.stringify(events), input.chat_url ? encryptSecret(input.chat_url) : null, input.chat_format ?? null, input.chat_url !== undefined],
  );
  return getSettings(user);
}

// ---- Unsubscribe -------------------------------------------------------------------------------

// Signed with the active key; links signed with an older key in the keyring keep working after a rotation (#63).
const unsubscribeSigWith = (raw: string, userId: number, event: string) =>
  createHmac('sha256', `kernel-unsubscribe:${raw}`).update(`${userId}:${event}`).digest('base64url');
const unsubscribeSig = (userId: number, event: string) => unsubscribeSigWith(activeKey()?.raw ?? '', userId, event);

export function unsubscribeUrl(userId: number, event: string) {
  return absoluteUrl(`/api/notifications/unsubscribe?u=${userId}&e=${event}&t=${unsubscribeSig(userId, event)}`);
}

/** Checks a signed unsubscribe link without changing anything; returns what it would unsubscribe from. */
export function checkUnsubscribe(userId: number, event: string, token: string) {
  if (!activeKey()) throw badRequest('Unsubscribe links are not configured');
  const given = Buffer.from(token);
  const valid = keyring().some((k) => {
    const expected = Buffer.from(unsubscribeSigWith(k.raw, userId, event));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  if (!valid) throw badRequest('Invalid unsubscribe link');
  if (event !== 'all' && !Object.hasOwn(EVENTS, event)) throw badRequest('Unknown event');
  return event === 'all' ? 'all email from Kernel' : `email when: ${EVENTS[event as NotificationEvent].label.toLowerCase()}`;
}

/** One-click unsubscribe (POST only: mail scanners prefetch GET links and must not unsubscribe anyone). */
export async function unsubscribe(userId: number, event: string, token: string) {
  checkUnsubscribe(userId, event, token);
  if (event === 'all') {
    await query('INSERT INTO notification_settings (user_id, email) VALUES ($1, false) ON CONFLICT (user_id) DO UPDATE SET email = false, updated_at = now()', [userId]);
  } else {
    if (!Object.hasOwn(EVENTS, event)) throw badRequest('Unknown event');
    const patch = JSON.stringify({ [event]: { email: false } });
    await query(
      `INSERT INTO notification_settings (user_id, events) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE
       SET events = notification_settings.events || jsonb_build_object($3::text, coalesce(notification_settings.events -> $3, '{}') || '{"email": false}'), updated_at = now()`,
      [userId, patch, event],
    );
  }
  return event === 'all' ? 'You will no longer receive email from Kernel. You can turn it on again in your settings.' : `You will no longer receive email when: ${EVENTS[event as NotificationEvent].label.toLowerCase()}.`;
}

// ---- Delivery ----------------------------------------------------------------------------------

/** Mail sent through the "capture:" transport, for tests and local development. */
export const capturedMail: { to: string; subject: string; text: string; headers: Record<string, string>; messageId?: string; attachments?: { filename: string; content: string }[] }[] = [];
let transporter: Transporter | null = null;
function mailer() {
  const url = process.env.SMTP_URL;
  if (!url) return null;
  if (url === 'capture:') {
    return { sendMail: async (m: any) => { capturedMail.push({ to: m.to, subject: m.subject, text: m.text, headers: m.headers, messageId: m.messageId, attachments: m.attachments }); return {}; } } as unknown as Transporter;
  }
  transporter ??= nodemailer.createTransport(url);
  return transporter;
}

/** Kernel's own sender address and Message-ID domain, so its own mail (and loops through it) is never handled. */
export function ownMail() {
  const from = (process.env.KERNEL_MAIL_FROM ?? 'Kernel <kernel@localhost>').match(/<([^>]+)>/)?.[1] ?? process.env.KERNEL_MAIL_FROM ?? '';
  let host = 'kernel.localhost';
  try {
    if (config.publicUrl) host = new URL(config.publicUrl).hostname;
  } catch { /* the default */ }
  return { address: from.toLowerCase(), messageIdDomain: host.toLowerCase() };
}

/**
 * Mail to someone outside Kernel's users (#46: status subscribers and organisation contacts), with its own signed
 * one-click unsubscribe link (RFC 8058).
 */
export async function sendOutsideMail(to: string, subject: string, lines: string[], unsubscribe: string | null) {
  const m = mailer();
  if (!m) throw new Error('Email is not configured (SMTP_URL)');
  await m.sendMail({
    from: process.env.KERNEL_MAIL_FROM ?? 'Kernel <kernel@localhost>',
    to,
    messageId: `<${randomUUID()}@${ownMail().messageIdDomain}>`,
    subject: clip(subject, 200),
    text: [...lines, ...(unsubscribe ? ['', '—', `Unsubscribe: ${unsubscribe}`] : [])].join('\n'),
    headers: { ...(unsubscribe ? { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}), 'Auto-Submitted': 'auto-generated' },
  });
}

export const mailConfigured = () => !!process.env.SMTP_URL;

/** A scheduled report to a Kernel user (#54): a summary, the report attached, and where to change or stop it. */
export async function sendReportMail(to: string, subject: string, lines: string[], attachment: { filename: string; content: string }, manage: string) {
  const m = mailer();
  if (!m) throw new Error('Email is not configured (SMTP_URL)');
  await m.sendMail({
    from: process.env.KERNEL_MAIL_FROM ?? 'Kernel <kernel@localhost>',
    to,
    messageId: `<${randomUUID()}@${ownMail().messageIdDomain}>`,
    subject: clip(subject, 200),
    text: [...lines, '', '—', `You scheduled this report. Change or stop it: ${manage}`].join('\n'),
    attachments: [{ filename: attachment.filename, content: attachment.content, contentType: 'text/markdown; charset=utf-8' }],
    headers: { 'Auto-Submitted': 'auto-generated' },
  });
}

async function sendEmail(userId: number, to: string, subject: string, lines: string[], event: string, messageId?: string) {
  const m = mailer();
  if (!m) throw new Error('Email is not configured (SMTP_URL)');
  const unsub = unsubscribeUrl(userId, event);
  await m.sendMail({
    from: process.env.KERNEL_MAIL_FROM ?? 'Kernel <kernel@localhost>',
    to,
    ...(messageId ? { messageId } : {}),
    subject: clip(subject, 200),
    text: [...lines, '', '—', `Notification settings: ${absoluteUrl('/settings')}`, `Unsubscribe: ${unsub}`].join('\n'),
    headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'Auto-Submitted': 'auto-generated' },
  });
}

/** How long an approval link works at most (approval-links.ts). */
export const APPROVAL_LINK_HOURS = 72;

/** The approval part of an email: links to decide, or why the approver has to sign in. */
function approvalLines(links: ApprovalLinks | 'sign_in' | null) {
  if (!links) return [];
  if (links === 'sign_in') return ['This needs you to sign in to decide:'];
  return [
    `Approve: ${links.approve}`,
    `Reject: ${links.reject}`,
    '',
    `The links are for you only, work once and expire within ${APPROVAL_LINK_HOURS} hours. Opening one changes nothing until you confirm on the page.`,
    '',
    'Or open it in Kernel:',
  ];
}

/** Sends due deliveries; claimed with a lease so replicas never send the same one twice. */
export async function processNotificationDeliveries(limit = 20) {
  const { sent } = await processOutbox({
    table: 'notification_deliveries', leaseSeconds: 120, limit, retryIn: backoffMinutes(1, 5, 30, 120), permanent: /not configured/,
    send: async (d: any) => {
      const { rows: u } = await query('SELECT u.id, u.email, u.display_name, s.chat_url, s.chat_format, s.last_digest_at FROM users u LEFT JOIN notification_settings s ON s.user_id = u.id WHERE u.id = $1', [d.user_id]);
      const user = u[0];
      if (d.channel === 'digest') {
        const { rows: items } = await query(
          'SELECT ref, title, summary, url FROM notifications WHERE user_id = $1 AND created_at > $2 AND created_at <= $3 ORDER BY created_at',
          [d.user_id, d.since ?? new Date(Date.now() - 86400_000), d.created_at],
        );
        if (!items.length) return 'skipped';
        await sendEmail(user.id, user.email, `Kernel: ${items.length} update${items.length === 1 ? '' : 's'} since yesterday`, items.flatMap((n) => [`${n.ref} ${n.title}`, `  ${n.summary}`, `  ${absoluteUrl(n.url)}`, '']), 'all');
        return;
      }
      const { rows: ns } = await query('SELECT * FROM notifications WHERE id = $1', [d.notification_id]);
      const n = ns[0];
      if (!n) throw new Error('Notification is gone');
      // Something to approve: links to decide from the message itself, minted per delivery (#48).
      // Loaded lazily: approval-links depends on changes and approvals, which depend on this module.
      const links = n.event === 'approval_needed' ? await (await import('./approval-links.js')).mintApprovalLink(n, user.id, d.channel, d.id) : null;
      if (d.channel === 'email') {
        // Recorded first, so a reply to this mail finds its record even if the send is retried (#48 inbound).
        const messageId = `<${randomUUID()}@${ownMail().messageIdDomain}>`;
        await query('UPDATE notification_deliveries SET message_id = $2 WHERE id = $1', [d.id, messageId]);
        await sendEmail(user.id, user.email, `[Kernel] ${n.ref ? `${n.ref}: ` : ''}${n.title}`, [n.summary, '', ...approvalLines(links), absoluteUrl(n.url)], n.event, messageId);
      } else {
        if (!user.chat_url) throw new Error('No chat webhook');
        const actions = links && links !== 'sign_in' ? [{ title: 'Approve', url: links.approve }, { title: 'Reject', url: links.reject }] : undefined;
        const body = JSON.stringify(formatBody(user.chat_format, { event: n.event, summary: n.summary, problem: { ref: n.ref, title: n.title, url: absoluteUrl(n.url) }, actions }));
        const res = await outboundFetch(decryptSecret(user.chat_url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Kernel-Notifications/1' }, body, maxBytes: 16_384 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
    },
  });
  return sent;
}

/** Queues one digest per user who chose it, once a day after 07:00 Swedish time. */
export async function queueDigests(now = Date.now()) {
  const tz = 'Europe/Stockholm';
  const today = localDate(tz, now);
  const sevenAm = zonedToUtc(tz, today.y, today.m, today.d, 7 * 60);
  if (now < sevenAm) return 0;
  const { rows } = await query(
    `UPDATE notification_settings s SET last_digest_at = $1
     FROM users u WHERE u.id = s.user_id AND u.active AND u.email <> '' AND s.digest AND s.email
       AND (s.last_digest_at IS NULL OR s.last_digest_at < $2)
     RETURNING s.user_id, (SELECT last_digest_at FROM notification_settings x WHERE x.user_id = s.user_id) AS previous`,
    [new Date(now), new Date(sevenAm)],
  );
  for (const r of rows) {
    await query("INSERT INTO notification_deliveries (user_id, channel, since) VALUES ($1, 'digest', $2)", [r.user_id, r.previous ?? new Date(now - 86400_000)]);
  }
  return rows.length;
}

/** Notifications are kept for 90 days, and so are the lists that bulk summaries link to (#125). */
export async function pruneNotifications() {
  await query("DELETE FROM notifications WHERE created_at < now() - interval '90 days'");
  await query("DELETE FROM bulk_requests WHERE created_at < now() - interval '90 days'");
}
