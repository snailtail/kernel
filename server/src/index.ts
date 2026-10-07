import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { authenticate, bootstrapAdmin } from './auth.js';
import { config } from './config.js';
import { migrate, pool, query, waitForDb } from './db.js';
import { HttpError } from './errors.js';
import { mcpRoutes } from './mcp.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { problemRoutes } from './routes/problems.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: process.env.KERNEL_TRUST_PROXY === 'true',
});
const log = (msg: string) => app.log.info(msg);

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
await app.register(mcpRoutes);

app.all('/api/*', async (_req, reply) => reply.code(404).send({ error: 'Not found' }));

// The React single page app, with client-side routing fallback.
if (existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET') return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
} else {
  log(`Web build not found at ${config.webDist}, serving API only`);
}

await waitForDb(log);
await migrate(log);
await bootstrapAdmin(log);
setInterval(() => query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {}), 3600_000).unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });
