import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireReason } from '../audit.js';
import { requireUser } from '../auth.js';
import * as status from '../status.js';
import * as subs from '../status-subscriptions.js';

type Ref = { Params: { ref: string } };

/** Cacheable public answers: a short max-age and an ETag, so a busy outage does not load Kernel. */
function cached(req: FastifyRequest, reply: FastifyReply, body: string, type: string) {
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
  reply.header('Cache-Control', 'public, max-age=30');
  reply.header('ETag', etag);
  if (req.headers['if-none-match'] === etag) return reply.code(304).send();
  return reply.type(type).send(body);
}

export async function statusRoutes(app: FastifyInstance) {
  app.get('/api/status', async (req) => status.statusBoard(requireUser(req)));
  app.put<Ref>('/api/status/:ref', async (req) => status.setServiceStatus(requireUser(req), req.params.ref, status.setStatusSchema.parse(req.body)));
  app.put<Ref>('/api/status/:ref/public', async (req) => status.setPublicService(requireUser(req), req.params.ref, status.publicServiceSchema.parse(req.body)));
  app.post('/api/status/updates', async (req, reply) => {
    reply.code(201);
    return status.postUpdate(requireUser(req), status.updateSchema.parse(req.body));
  });
  // The reason travels in the body: query strings end up in proxy and request logs, and reasons may describe people.
  app.post<{ Params: { id: string } }>('/api/status/updates/:id/retract', async (req) => {
    const user = requireUser(req);
    const body = z.object({ reason: z.string().max(1000).optional() }).parse(req.body ?? {});
    return status.retractUpdate(user, Number(req.params.id), requireReason(body.reason));
  });
  // The old shape, kept for one release so callers learn where it moved.
  app.delete('/api/status/updates/:id', async (req, reply) => {
    requireUser(req);
    return reply.code(400).send({ error: 'Retract with POST /api/status/updates/:id/retract and { "reason": "…" } in the body' });
  });
  app.put<Ref>('/api/status/:ref/follow', async (req) => subs.followService(requireUser(req), req.params.ref, z.object({ follow: z.boolean() }).parse(req.body).follow));
  app.put('/api/admin/status-page', async (req) => {
    const user = requireUser(req);
    const body = z.object({ public_enabled: z.boolean(), title: z.string().trim().min(1).max(100), reason: z.string().max(1000).optional() }).parse(req.body);
    return status.savePageSettings(user, { public_enabled: body.public_enabled, title: body.title }, requireReason(body.reason));
  });

  // The public surface: no session, no auth, GET only, published data only.
  app.get('/api/public/status', async (req, reply) => {
    const page = await status.publicStatus();
    if (!page) return reply.code(404).send({ error: 'There is no public status page' });
    return cached(req, reply, JSON.stringify(page), 'application/json; charset=utf-8');
  });
  app.get('/status', async (req, reply) => {
    const page = await status.publicStatus();
    reply.header('Content-Security-Policy', CSP);
    if (!page) return reply.code(404).type('text/plain; charset=utf-8').send('There is no public status page.');
    return cached(req, reply, status.publicStatusHtml(page), 'text/html; charset=utf-8');
  });

  // Email subscriptions from the public page (#46): no session; forms post here, mail links land here. Each answer is
  // a small page under the same strict CSP (or JSON for API callers). Tokens travel in ?token=, which logs redact.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16_384 }, (_req, body, done) => done(null, body));
    const wantsHtml = (req: FastifyRequest) => String(req.headers.accept ?? '').includes('text/html');
    const answer = (req: FastifyRequest, reply: FastifyReply, text: string, form = '', code = 200) => {
      reply.code(code).header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      if (!wantsHtml(req) && req.method === 'POST') return code < 400 ? { ok: true, message: text } : { error: text };
      return reply.header('Content-Security-Policy', CSP).type('text/html; charset=utf-8').send(status.outsidePage(text, form));
    };
    // Refusals become a page too, so someone following a link from a mail sees a sentence, not JSON.
    const guarded = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(req, reply);
      } catch (err) {
        const code = err instanceof z.ZodError ? 400 : (err as { statusCode?: number }).statusCode;
        if (!code || code >= 500) throw err;
        return answer(req, reply, err instanceof z.ZodError ? 'Enter a valid email address.' : (err as Error).message, '', code);
      }
    };
    const form = (action: string, label: string) => `<form method="post" action="${status.esc(action)}"><button type="submit">${status.esc(label)}</button></form>`;

    scope.post('/status/subscribe', guarded(async (req, reply) => {
      const raw = typeof req.body === 'string' ? new URLSearchParams(req.body) : null;
      const input = subs.signUpSchema.parse(raw ? { email: raw.get('email') ?? '', services: raw.getAll('service') } : req.body);
      return answer(req, reply, (await subs.signUp(input, req.ip)).message);
    }));
    const confirmQuery = z.object({ s: z.coerce.number().int().positive(), token: z.string().min(20).max(100) });
    // GET only shows what would be confirmed: link scanners open every link in a mail.
    scope.get('/status/confirm', guarded(async (req, reply) => {
      const q = confirmQuery.parse(req.query);
      const what = await subs.checkConfirm(q.s, q.token);
      return answer(req, reply, `Receive ${what} by email?`, form(`/status/confirm?s=${q.s}&token=${encodeURIComponent(q.token)}`, 'Confirm'));
    }));
    scope.post('/status/confirm', guarded(async (req, reply) => {
      const q = confirmQuery.parse(req.query);
      return answer(req, reply, await subs.confirm(q.s, q.token));
    }));
    const unsubQuery = z.object({ s: z.coerce.number().int().positive().optional(), p: z.coerce.number().int().positive().optional(), token: z.string().max(100) })
      .refine((q) => !!q.s !== !!q.p, 'Invalid unsubscribe link');
    const who = (q: z.infer<typeof unsubQuery>) => (q.s ? (['s', q.s] as const) : (['p', q.p!] as const));
    scope.get('/status/unsubscribe', guarded(async (req, reply) => {
      const q = unsubQuery.parse(req.query);
      const [w, id] = who(q);
      return answer(req, reply, subs.checkUnsubscribe(w, id, q.token), form(`/status/unsubscribe?${w}=${id}&token=${encodeURIComponent(q.token)}`, 'Unsubscribe'));
    }));
    // The one-click POST (RFC 8058) from the mail client, or the button above.
    scope.post('/status/unsubscribe', guarded(async (req, reply) => {
      const q = unsubQuery.parse(req.query);
      const [w, id] = who(q);
      return answer(req, reply, await subs.unsubscribe(w, id, q.token));
    }));
  });
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
