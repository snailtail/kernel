import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import * as n from '../notifications.js';

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
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 }, (_req, body, done) => done(null, body));
    const params = z.object({ u: z.coerce.number().int(), e: z.string().max(40), t: z.string().max(100) });
    const page = (text: string) =>
      `<!doctype html><meta charset="utf-8"><title>Kernel</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Kernel</h1><p>${text.replace(/[<>&]/g, '')}</p></body>`;
    // GET only shows a confirmation: link scanners (Safe Links, Proofpoint…) open every link in a mail.
    scope.get('/api/notifications/unsubscribe', async (req, reply) => {
      const p = params.parse(req.query);
      const what = n.checkUnsubscribe(p.u, p.e, p.t);
      const action = `/api/notifications/unsubscribe?u=${p.u}&e=${encodeURIComponent(p.e)}&t=${encodeURIComponent(p.t)}`;
      reply.type('text/html').send(
        page(`Stop ${what}?`).replace('</body>', `<form method="post" action="${action}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit" style="font:inherit;padding:.5rem 1rem">Unsubscribe</button></form></body>`),
      );
    });
    // The one-click POST (RFC 8058) from the mail client, or the confirmation button above.
    scope.post('/api/notifications/unsubscribe', async (req, reply) => {
      const p = params.parse(req.query);
      const message = await n.unsubscribe(p.u, p.e, p.t);
      if (String(req.headers.accept ?? '').includes('text/html')) return reply.type('text/html').send(page(message));
      return { ok: true, message };
    });
  });
}
