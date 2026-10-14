import { existsSync } from 'node:fs';
import { assertMayWriteText, maskForViewer } from './confidential.js';
import { sensitiveRoutes } from './routes/sensitive.js';
import { markPersonalData, scanInbound } from './sensitive.js';
import { liveRoutes } from './routes/live.js';
import { startLive, stopLive } from './live.js';
import { ssoRoutes } from './routes/sso.js';
import { serviceReportRoutes } from './routes/service-report.js';
import { statusRoutes } from './routes/status.js';
import { viewerFor } from './visibility.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { authenticate } from './auth.js';
import { config } from './config.js';
import { contextStore } from './context.js';
import { query } from './db.js';
import { HttpError } from './errors.js';
import { createLogger, logger } from './log.js';
import { mcpRoutes } from './mcp.js';
import { openApiDocument } from './openapi.js';
import { registerIdempotency } from './idempotency.js';
import { registerSecurity } from './security.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { integrationRoutes } from './routes/integrations.js';
import { cmdbRoutes } from './routes/cmdb.js';
import { incidentRoutes } from './routes/incidents.js';
import { eventRoutes } from './routes/events.js';
import { changeRoutes } from './routes/changes.js';
import { slaRoutes } from './routes/sla.js';
import { refreshModules } from './modules.js';
import { notificationRoutes } from './routes/notifications.js';
import { setupRoutes } from './routes/setup.js';
import { connectorRoutes } from './routes/connectors.js';
import { peopleRoutes } from './routes/people.js';
import { attachmentRoutes } from './routes/attachments.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { teamRoutes } from './routes/teams.js';
import { visibilityRoutes } from './routes/visibility.js';
import { devRoutes } from './routes/dev.js';
import { aiRoutes } from './routes/ai.js';
import { problemRoutes } from './routes/problems.js';

declare module 'fastify' {
  interface FastifyInstance {
    kernelRoutes: { method: string; url: string }[];
  }
}

/** Builds the HTTP application: API, MCP endpoint and (if built) the web UI. */
export async function buildApp(options: { logLevel?: string; serveWeb?: boolean } = {}) {
  await refreshModules();
  const app = Fastify({
    loggerInstance: options.logLevel ? createLogger({ level: options.logLevel }) : logger,
    // A hop count is supported at runtime (proxy-addr) but missing from Fastify's types.
    trustProxy: config.trustProxy as boolean | string[],
    // JSON bodies up to 1 MB (long texts plus their `base` values); bulk ingest and MCP allow more per route.
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await registerSecurity(app);
  // Only JSON request bodies: text/plain and form posts are what cross-site forms could send (CSRF).
  app.removeContentTypeParser('text/plain');

  // Registered routes, so tests can check that the OpenAPI document covers them.
  const routes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (r) => {
    for (const method of ([] as string[]).concat(r.method)) routes.push({ method: method.toLowerCase(), url: r.url });
  });
  app.decorate('kernelRoutes', routes);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; ') });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, ...err.details });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Internal server error' });
  });

  app.addHook('onRequest', async (req) => {
    // Event hooks authenticate with their own source token (event-hooks.ts), never as a user.
    // Event and dev platform hooks authenticate with their own token or signature, never as a user.
    if ((req.url.startsWith('/api/') && !req.url.startsWith('/api/event-hooks/') && !req.url.startsWith('/api/dev-hooks/') && !req.url.startsWith('/api/public/')) || req.url.startsWith('/mcp')) await authenticate(req);
  });
  // Who is acting and how, for the audit trail; the rest of the request runs inside this context.
  app.addHook('onRequest', (req, _reply, done) => {
    const u = req.user;
    const bearer = !!req.headers.authorization && !!u;
    const channel = req.url.startsWith('/mcp') ? 'mcp' : bearer ? 'api' : 'web';
    // Anonymous requests see no restricted or team-scoped rows; signed-in users see what the database rule allows.
    const viewer = u ? viewerFor(u, channel) : Promise.resolve('');
    viewer.then((v) => contextStore.run(
      {
        viewer: v,
        userId: u?.id ?? null,
        userName: u?.username ?? '',
        actorType: !u ? 'anonymous' : bearer ? (u.role === 'integration' ? 'integration' : req.url.startsWith('/mcp') ? 'mcp' : 'api_token') : 'user',
        channel,
        tokenPrefix: req.tokenPrefix ?? '',
        ip: req.ip,
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
        requestId: String(req.id),
      },
      done,
    ), done);
  });

  app.get('/healthz', async () => {
    await query('SELECT 1');
    return { status: 'ok' };
  });

  registerIdempotency(app);
  await app.register(authRoutes);
  await app.register(problemRoutes);
  await app.register(adminRoutes);
  await app.register(integrationRoutes);
  await app.register(cmdbRoutes);
  await app.register(incidentRoutes);
  await app.register(eventRoutes);
  await app.register(changeRoutes);
  await app.register(slaRoutes);
  await app.register(notificationRoutes);
  await app.register(setupRoutes);
  await app.register(connectorRoutes);
  await app.register(peopleRoutes);
  await app.register(attachmentRoutes);
  await app.register(knowledgeRoutes);
  await app.register(teamRoutes);
  await app.register(visibilityRoutes);
  await app.register(devRoutes);
  await app.register(aiRoutes);
  await app.register(mcpRoutes);
  await app.register(statusRoutes);
  await app.register(serviceReportRoutes);
  await app.register(ssoRoutes);
  await app.register(liveRoutes);
  await app.register(sensitiveRoutes);
  // Sensitive data (#61): secrets in inbound text are redacted before any handler sees them (or the request is
  // refused, by policy); personal data marks the record it was written to.
  app.addHook('preHandler', async (req, reply) => {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return;
    const path = req.url.split('?')[0];
    const result = await scanInbound(path, req.body);
    if (!result) return;
    req.body = result.body;
    if (result.secrets.length) {
      reply.header('X-Kernel-Redacted', result.secrets.join(','));
      req.log.warn({ event: { dataset: 'kernel.security', action: 'sensitive.redacted' }, types: result.secrets, path }, 'Secrets redacted from input');
    }
    if (result.personal.length) (req as any).personalData = true;
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (!(req as any).personalData || reply.statusCode >= 300) return payload;
    let ref = (req.params as { ref?: string } | undefined)?.ref;
    if (!ref && typeof payload === 'string') {
      try { ref = JSON.parse(payload)?.ref; } catch { /* not JSON */ }
    }
    if (ref) await markPersonalData(ref).catch(() => {});
    return payload;
  });
  // Confidential records (#61): the server masks their free text for anyone not working on them, unless revealed.
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.user || reply.statusCode >= 300 || typeof payload !== 'string' || !payload.includes('"ref"')) return payload;
    if (!String(reply.getHeader('content-type') ?? '').includes('application/json')) return payload;
    const pageRef = /^\/api\/(problems|incidents|changes|records)\/[^/]+/.test(req.url) ? (req.params as { ref?: string } | undefined)?.ref : undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { return payload; }
    const before = payload.length;
    const out = JSON.stringify(await maskForViewer(req.user, parsed, pageRef));
    return out.length === before && out === payload ? payload : out;
  });
  app.addHook('preHandler', async (req) => {
    // No blind overwrites: changing a masked field needs the right to read it.
    if (!['PATCH', 'PUT'].includes(req.method) || !/^\/api\/(problems|incidents|changes)\/[^/]+$/.test(req.url.split('?')[0])) return;
    const ref = (req.params as { ref?: string } | undefined)?.ref;
    if (ref) await assertMayWriteText(req, ref, req.body);
  });
  app.addHook('onReady', async () => startLive((msg) => app.log.warn(msg)));
  app.addHook('onClose', async () => stopLive());

  app.get('/api/openapi.json', async (req) => openApiDocument(config.publicUrl ?? `${req.protocol}://${req.host}`));

  app.all('/api/*', async (_req, reply) => reply.code(404).send({ error: 'Not found' }));

  // The React single page app, with client-side routing fallback.
  if (options.serveWeb !== false && existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET') return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  } else if (options.serveWeb !== false) {
    app.log.info(`Web build not found at ${config.webDist}, serving API only`);
  }

  return app;
}
