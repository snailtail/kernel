import { buildApp } from './app.js';
import { startChainVerification } from './audit.js';
import { asSystem } from './context.js';
import { checkConfiguration } from './security.js';
import { bootstrapAdmin } from './auth.js';
import { config } from './config.js';
import { migrate, pool, query, waitForDb } from './db.js';
import { encryptLegacySecrets, startWorker } from './webhooks.js';

const app = await buildApp();
const log = (msg: string) => app.log.info(msg);
checkConfiguration((msg) => app.log.warn(msg));

await waitForDb(log);
await migrate(log);
await bootstrapAdmin(log);
await encryptLegacySecrets(log);
setInterval(() => query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {}), 3600_000).unref();
asSystem(() => {
  startWorker(log);
  startChainVerification((msg) => app.log.error(msg));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });
