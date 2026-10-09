import type { FastifyInstance, FastifyReply } from 'fastify';
import { Transform } from 'node:stream';
import { z } from 'zod';
import * as att from '../attachments.js';
import { requireUser } from '../auth.js';
import { HttpError } from '../errors.js';
import { rateLimit } from '../ratelimit.js';

type Id = { Params: { id: string } };

/** Every attachment response: never sniffed, never scripted, never framed (PDFs only by Kernel itself). */
function send(reply: FastifyReply, file: { attachment: { filename: string; kind: string }; contentType: string; data: Buffer }, inline: boolean) {
  const showInline = inline && (file.attachment.kind === 'image' || file.attachment.kind === 'pdf');
  const name = file.attachment.filename;
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Disposition', `${showInline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  if (file.attachment.kind === 'pdf' && showInline) {
    // Trade-off: Chrome's PDF viewer refuses a sandboxed response, so inline PDFs get no `sandbox`. They are still
    // same-origin only (frame-ancestors 'self'), loaded with default-src 'none', and shown only in Kernel's own frame.
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
    reply.header('X-Frame-Options', 'SAMEORIGIN');
  } else {
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
  }
  // Text is always served as plain text (an uploaded .html or .svg is shown as source, never rendered).
  return reply.type(file.contentType).send(file.data);
}

export async function attachmentRoutes(app: FastifyInstance) {
  // Registered without fastify-plugin, so this parser exists only in this encapsulated scope: other routes (sign-in,
  // event hooks…) never buffer raw bodies. HARD_LIMIT bounds what Fastify reads; the configured limit is checked from
  // Content-Length before reading, and each user has an upload rate.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: att.HARD_LIMIT }, (_req, body, done) => done(null, body));
  app.addHook('preParsing', async (req, _reply, payload) => {
    if (req.method !== 'POST') return payload;
    // Who may upload is decided before a byte of the body is read.
    const user = requireUser(req, 'attachment.add');
    rateLimit(`upload:${user.id}`, 60, 60_000);
    const max = (await att.maxUploadBytes()) + 64 * 1024;
    const tooLarge = () => new HttpError(413, `Files may be at most ${Math.round((max - 64 * 1024) / 1024 / 1024)} MB`);
    if (Number(req.headers['content-length'] ?? 0) > max) throw tooLarge();
    // Chunked uploads carry no length: count while reading and stop at the limit.
    let seen = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _enc, done) {
        seen += chunk.length;
        if (seen > max) return done(tooLarge());
        done(null, chunk);
      },
    });
    payload.on('error', (err) => counted.destroy(err));
    return payload.pipe(counted);
  });

  app.get<{ Params: { ref: string } }>('/api/records/:ref/attachments', async (req) => att.listAttachments(requireUser(req), req.params.ref));
  app.post<{ Params: { ref: string }; Querystring: { filename?: string } }>('/api/records/:ref/attachments', { bodyLimit: att.HARD_LIMIT }, async (req, reply) => {
    const user = requireUser(req);
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'Send the file as application/octet-stream with ?filename=' });
    reply.code(201);
    return att.addAttachment(user, req.params.ref, z.string().max(300).default('attachment').parse(req.query.filename), req.body);
  });
  app.get<Id & { Querystring: { inline?: string } }>('/api/attachments/:id', async (req, reply) => send(reply, await att.getAttachmentData(requireUser(req), Number(req.params.id), 'original'), req.query.inline === '1'));
  app.get<Id>('/api/attachments/:id/preview', async (req, reply) => send(reply, await att.getAttachmentData(requireUser(req), Number(req.params.id), 'preview'), true));
  app.get<Id>('/api/attachments/:id/thumb', async (req, reply) => send(reply, await att.getAttachmentData(requireUser(req), Number(req.params.id), 'thumb'), true));
  app.get<Id & { Querystring: { from?: string; limit?: string } }>('/api/attachments/:id/text', async (req) =>
    att.getAttachmentText(requireUser(req), Number(req.params.id), Number(req.query.from ?? 0) || 0, Number(req.query.limit ?? 2000) || 2000),
  );
  app.delete<Id>('/api/attachments/:id', async (req) => att.deleteAttachment(requireUser(req), Number(req.params.id)));
}
