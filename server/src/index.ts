import { buildApp } from './app.js';
import { logger } from './log.js';
import { pruneDeliveries, refreshWindowStatuses } from './dev.js';
import { startChainVerification } from './audit.js';
import { purgeSecurityEvents } from './security-events.js';
import { asSystem } from './context.js';
import { pruneIdempotencyKeys } from './idempotency.js';
import { checkConfiguration } from './security.js';
import { recordActiveKey } from './rotate-keys.js';
import { bootstrapAdmin } from './auth.js';
import { config } from './config.js';
import { migrate, pool, query, waitForDb } from './db.js';
import { encryptLegacySecrets, startWorker } from './webhooks.js';
import { startEventWorker } from './events.js';
import { startSecurityAlertWorker } from './security-alerts.js';
import { startSlaWorker } from './sla.js';
import { startNotificationWorker } from './notifications.js';
import { startStatusWorker } from './status-subscriptions.js';
import { startRequestWorker } from './requests.js';
import { startPortalWorker } from './portal.js';
import { startConnectorWorker } from './connectors.js';
import { startMajorIncidentWorker } from './major-incidents.js';
import { startPagingWorker } from './oncall.js';
import { startReportScheduleWorker } from './report-schedules.js';
import { startRuleWorker } from './rules.js';
import { moduleEnabled } from './modules.js';

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
// Security events and the addresses tokens were used from, likewise (settings.privacy.security_event_days, #64).
setInterval(() => purgeSecurityEvents().catch(() => {}), 86400_000).unref();
asSystem(() => {
  startWorker(log);
  startEventWorker(log);
  startSecurityAlertWorker(log);
  startSlaWorker(log);
  startNotificationWorker(log);
  startStatusWorker(log);
  startRequestWorker(log);
  startPortalWorker(log);
  startConnectorWorker(log);
  startMajorIncidentWorker(log, () => moduleEnabled('incident'));
  startPagingWorker(log, () => moduleEnabled('incident'));
  startReportScheduleWorker(log);
  startRuleWorker(log);
  startChainVerification((msg) => app.log.error(msg));
  setInterval(() => pruneIdempotencyKeys().catch(() => {}), 3600_000).unref();
  setInterval(() => pruneDeliveries().catch(() => {}), 3600_000).unref();
  // A change window opening or closing changes the status on its pull requests (#32).
  setInterval(() => refreshWindowStatuses().catch(() => {}), 5 * 60_000).unref();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });
