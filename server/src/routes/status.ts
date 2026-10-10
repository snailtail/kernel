import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireReason } from '../audit.js';
import { requireUser } from '../auth.js';
import * as status from '../status.js';

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
  app.delete<{ Params: { id: string }; Querystring: { reason?: string } }>('/api/status/updates/:id', async (req) =>
    status.retractUpdate(requireUser(req), Number(req.params.id), requireReason(req.query.reason)),
  );
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
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (!page) return reply.code(404).type('text/plain; charset=utf-8').send('There is no public status page.');
    return cached(req, reply, status.publicStatusHtml(page), 'text/html; charset=utf-8');
  });
}
