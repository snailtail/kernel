import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkApprovalLink, useApprovalLink } from '../approval-links.js';
import { requireUser } from '../auth.js';
import { forbidden, HttpError } from '../errors.js';
import * as n from '../notifications.js';
import { securityEvent } from '../security-events.js';
import { checkSameOrigin } from '../security.js';

export async function notificationRoutes(app: FastifyInstance) {
  app.get('/api/notifications', async (req) => {
    const q = z.object({ unread: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return n.listNotifications(requireUser(req), q.unread, q.limit);
  });
  app.post('/api/notifications/read', async (req) => {
    const body = z.object({ ids: z.array(z.number().int()).max(500).optional(), all: z.boolean().optional() }).parse(req.body);
    return n.markRead(requireUser(req), body.all ? 'all' : (body.ids ?? []));
  });
  app.get('/api/notifications/settings', async (req) => n.getSettings(requireUser(req)));
  app.put('/api/notifications/settings', async (req) => n.saveSettings(requireUser(req), n.settingsSchema.parse(req.body)));

  // One-click unsubscribe from an email link (RFC 8058): no login; mail clients POST a form body.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16_384 }, (_req, body, done) => done(null, body));
    const params = z.object({ u: z.coerce.number().int(), e: z.string().max(40), t: z.string().max(100) });
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    // Every interpolated value is escaped (text) or URL-encoded and escaped (attribute).
    const page = (text: string, form = '') =>
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"><title>Kernel</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Kernel</h1><p>${esc(text)}</p>${form}</body>`;
    // GET only shows a confirmation: link scanners (Safe Links, Proofpoint…) open every link in a mail.
    scope.get('/api/notifications/unsubscribe', async (req, reply) => {
      const p = params.parse(req.query);
      const what = n.checkUnsubscribe(p.u, p.e, p.t);
      const action = `/api/notifications/unsubscribe?u=${p.u}&e=${encodeURIComponent(p.e)}&t=${encodeURIComponent(p.t)}`;
      // nosemgrep: raw-html-format -- values are escaped by esc() above
      const form = `<form method="post" action="${esc(action)}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit" style="font:inherit;padding:.5rem 1rem">Unsubscribe</button></form>`;
      reply.type('text/html').send(page(`Stop ${what}?`, form));
    });
    // The one-click POST (RFC 8058) from the mail client, or the confirmation button above.
    scope.post('/api/notifications/unsubscribe', async (req, reply) => {
      const p = params.parse(req.query);
      const message = await n.unsubscribe(p.u, p.e, p.t);
      if (String(req.headers.accept ?? '').includes('text/html')) return reply.type('text/html').send(page(message));
      return { ok: true, message };
    });

    // Approve or reject from an email or chat link (#48, approval-links.ts). No login and no cookie: the token in the
    // link is the credential, bound to one approver and one decision. The token travels in ?token=, which the request
    // log redacts.
    const link = z.object({ token: z.string().min(20).max(100), decision: z.enum(['approve', 'reject']).optional() });
    const openLink = (path?: string, label = 'Open in Kernel') => (path ? `<p><a href="${esc(path)}">${esc(label)}</a></p>` : '');
    const send = (reply: any, html: string, status = 200) => reply.code(status).header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').type('text/html').send(html);
    // GET only shows the request and a form: link scanners open every link in a mail.
    scope.get('/api/public/approval-links', async (req, reply) => {
      const q = link.parse(req.query);
      const s = await checkApprovalLink(req, q.token);
      if (!s.ok) return send(reply, page(s.message, openLink(s.path, s.reason === 'sign_in' ? 'Sign in to decide' : undefined)), 410);
      const facts = s.subject.facts.map(([k, v]) => `<dt style="font-weight:600">${esc(k)}</dt><dd style="margin:0 0 .5rem">${esc(v)}</dd>`).join('');
      const choice = (value: string, label: string) =>
        `<label style="margin-right:1rem"><input type="radio" name="decision" value="${value}" required${q.decision === value ? ' checked' : ''}> ${label}</label>`;
      const action = `/api/public/approval-links?token=${encodeURIComponent(q.token)}`;
      // nosemgrep: raw-html-format -- ref, title and facts are escaped by esc() above
      const head = `<h2 style="font-size:1.1rem">${esc(s.subject.ref)}: ${esc(s.subject.title)}</h2><dl>${facts}</dl>`;
      // nosemgrep: raw-html-format -- the action is escaped; choice() takes only the literals below
      const start = `<form method="post" action="${esc(action)}"><p>${choice('approve', 'Approve')}${choice('reject', 'Reject')}</p>`;
      const comment = '<p><label>Comment (required to reject)<br><textarea name="comment" rows="4" maxlength="5000" style="width:100%;font:inherit"></textarea></label></p>';
      // nosemgrep: raw-html-format -- the form token is escaped by esc() above
      const submit = `<input type="hidden" name="form" value="${esc(s.formToken)}"><button type="submit" style="font:inherit;padding:.5rem 1rem">Confirm</button></form>`;
      const form = [head, start, comment, submit, openLink(s.subject.path)].join('\n');
      return send(reply, page(`You decide as ${s.user.display_name}. Nothing happens until you confirm.`, form));
    });
    scope.post('/api/public/approval-links', async (req, reply) => {
      const q = link.parse(req.query);
      try {
        // The form is posted from the page above: a browser always sends Origin on a form POST.
        try {
          if (!req.headers.origin) throw forbidden('Cross-site request rejected');
          checkSameOrigin(req);
        } catch (err) {
          securityEvent({ action: 'approval_link.refused', category: 'authentication', outcome: 'denied', message: 'Approval link refused: origin', detail: { reason: 'origin' } }, req);
          throw err;
        }
        const body = new URLSearchParams(typeof req.body === 'string' ? req.body : '');
        const r = await useApprovalLink(req, q.token, { decision: body.get('decision') ?? '', comment: body.get('comment') ?? '', form: body.get('form') ?? '' });
        return send(reply, page(r.message, openLink(r.path)), r.ok ? 200 : 410);
      } catch (err) {
        if (err instanceof HttpError && err.statusCode < 500) return send(reply, page(err.message), err.statusCode);
        throw err;
      }
    });
  });
}
