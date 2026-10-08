import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { authenticate } from './auth.js';
import { config } from './config.js';
import { query } from './db.js';
import { HttpError } from './errors.js';
import { mcpRoutes } from './mcp.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { integrationRoutes } from './routes/integrations.js';
import { problemRoutes } from './routes/problems.js';

/** Builds the HTTP application: API, MCP endpoint and (if built) the web UI. */
export async function buildApp(options: { logLevel?: string; serveWeb?: boolean } = {}) {
  const app = Fastify({
    logger: { level: options.logLevel ?? process.env.LOG_LEVEL ?? 'info' },
    trustProxy: process.env.KERNEL_TRUST_PROXY === 'true',
  });

  await app.register(cookie);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; ') });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Internal server error' });
  });

  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/mcp')) await authenticate(req);
  });

  app.get('/healthz', async () => {
    await query('SELECT 1');
    return { status: 'ok' };
  });

  await app.register(authRoutes);
  await app.register(problemRoutes);
  await app.register(adminRoutes);
  await app.register(integrationRoutes);
  await app.register(mcpRoutes);

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
