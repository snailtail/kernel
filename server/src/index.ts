import { buildApp } from './app.js';
import { logger } from './log.js';
import { pruneDeliveries } from './dev.js';
import { startChainVerification } from './audit.js';
import { asSystem } from './context.js';
import { pruneIdempotencyKeys } from './idempotency.js';
import { checkConfiguration } from './security.js';
import { recordActiveKey } from './rotate-keys.js';
import { bootstrapAdmin } from './auth.js';
import { config } from './config.js';
import { migrate, pool, query, waitForDb } from './db.js';
import { encryptLegacySecrets, startWorker } from './webhooks.js';
import { startEventWorker } from './events.js';
import { startSlaWorker } from './sla.js';
import { startNotificationWorker } from './notifications.js';
import { startConnectorWorker } from './connectors.js';

// The schema comes first: building the app already reads settings (modules), which a new database does not have yet.
const early = (msg: string) => logger.info(msg);
checkConfiguration((msg) => logger.warn(msg));
await waitForDb(early);
await migrate(early);

const app = await buildApp();
const log = (msg: string) => app.log.info(msg);
await bootstrapAdmin(log);
await encryptLegacySecrets(log);
await recordActiveKey();
setInterval(() => query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {}), 3600_000).unref();
// IP addresses and user agents of audit entries are kept for a limited time (settings.privacy.audit_context_days).
setInterval(() => query("DELETE FROM audit_context WHERE created_at < now() - coalesce((SELECT (value->>'audit_context_days')::int FROM settings WHERE key = 'privacy'), 365) * interval '1 day'").catch(() => {}), 86400_000).unref();
asSystem(() => {
  startWorker(log);
  startEventWorker(log);
  startSlaWorker(log);
  startNotificationWorker(log);
  startConnectorWorker(log);
  startChainVerification((msg) => app.log.error(msg));
  setInterval(() => pruneIdempotencyKeys().catch(() => {}), 3600_000).unref();
  setInterval(() => pruneDeliveries().catch(() => {}), 3600_000).unref();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });
