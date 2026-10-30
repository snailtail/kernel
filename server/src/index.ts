import { buildApp } from './app.js';
import { logger } from './core/log.js';
import { pruneDeliveries, refreshWindowStatuses } from './integrations/dev.js';
import { runChainVerification } from './security/audit.js';
import { closeWindows as closeSecurityEventWindows, purgeSecurityEvents } from './security/security-events.js';
import { asSystem } from './core/context.js';
import { pruneIdempotencyKeys } from './idempotency.js';
import { checkConfiguration } from './security/security.js';
import { recordActiveKey } from './security/rotate-keys.js';
import { bootstrapAdmin } from './security/auth.js';
import { config } from './core/config.js';
import { migrate, pool, query, waitForDb } from './core/db.js';
import { encryptLegacySecrets, notifyOverdueActions, processDeliveries, pruneDeliveries as pruneWebhookDeliveries } from './notifications/webhooks.js';
import { autoResolveIncidents, purgeEvents } from './events/events.js';
import { runSecurityAlerting } from './events/security-alerts.js';
import { backfillSla, checkSlaEvents } from './reporting/sla.js';
import { processNotificationDeliveries, pruneNotifications, queueDigests } from './notifications/notifications.js';
import { processStatusDeliveries, pruneStatusSubscriptions } from './status/status-subscriptions.js';
import { processRequestMail } from './requests/requests.js';
import { processPortalMail, prunePortal } from './requests/portal.js';
import { runDueConnectors } from './integrations/connectors.js';
import { reconcileDueMirrors, sendSourceComments } from './development/mirror.js';
import { checkOverdueUpdates } from './incidents/major-incidents.js';
import { deliverPages } from './people/oncall.js';
import { processReportDeliveries, queueScheduledReports } from './reporting/report-schedules.js';
import { pruneRuleRuns, runRules, runTimeTriggers } from './automation/rules.js';
import { onRulesQueued } from './automation/rule-queue.js';
import { every } from './core/workers.js';
import { moduleEnabled } from './core/modules.js';

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

// Every background job: how often it runs, and when it is off. Each runs one at a time on this replica; the jobs
// themselves are safe with several replicas (deliveries are claimed with a lease).
asSystem(() => {
  const on = (module: Parameters<typeof moduleEnabled>[0]) => () => moduleEnabled(module);
  const MINUTE = 60_000;
  const HOUR = 3600_000;
  const DAY = 86400_000;
  // Deliveries: webhooks drain the queue while there is more.
  every(5_000, 'webhook delivery', async () => { while ((await processDeliveries()) > 0); });
  every(15_000, 'notification delivery', () => processNotificationDeliveries());
  every(MINUTE, 'digest', () => queueDigests());
  every(15_000, 'status delivery', () => processStatusDeliveries());
  every(15_000, 'request mail', () => processRequestMail(), { when: on('request') });
  every(10_000, 'portal mail', () => processPortalMail(), { when: on('portal') });
  every(15 * MINUTE, 'report schedule', () => queueScheduledReports());
  every(MINUTE, 'report delivery', () => processReportDeliveries());
  every(5_000, 'paging', () => deliverPages(), { when: on('incident') });
  // Automation: woken right after a change commits; the interval picks up what another replica queued or a crash
  // left behind. Time triggers are looked for every minute, and what they queue runs right away.
  const rules = every(5_000, 'automation rules', () => runRules());
  onRulesQueued(() => setImmediate(rules));
  every(MINUTE, 'automation time triggers', async () => (await runTimeTriggers()) && rules());
  // Checks.
  every(MINUTE, 'connector scheduler', () => runDueConnectors());
  every(MINUTE, 'work item mirrors', () => reconcileDueMirrors(), { when: on('development') });
  every(MINUTE, 'work item source comments', () => sendSourceComments(), { when: on('development') });
  every(MINUTE, 'event auto-resolve', () => autoResolveIncidents(), { when: () => moduleEnabled('event') && moduleEnabled('incident') });
  every(MINUTE, 'SLA check', () => checkSlaEvents(), { when: on('sla') });
  every(MINUTE, 'major incident check', () => checkOverdueUpdates(), { when: on('incident') });
  every(15_000, 'security event summaries', async () => closeSecurityEventWindows());
  every(MINUTE, 'security alerting', () => runSecurityAlerting());
  every(HOUR, 'overdue actions', () => notifyOverdueActions(), { firstAfter: 0 });
  every(HOUR, 'audit chain verification', () => runChainVerification(), { firstAfter: 10_000 });
  // A change window opening or closing changes the status on its pull requests (#32).
  every(5 * MINUTE, 'change window status', () => refreshWindowStatuses());
  // Retention.
  every(HOUR, 'session cleanup', () => query('DELETE FROM sessions WHERE expires_at < now()'));
  // IP addresses and user agents of audit entries are kept for a limited time (settings.privacy.audit_context_days).
  every(DAY, 'audit context cleanup', () => query("DELETE FROM audit_context WHERE created_at < now() - coalesce((SELECT (value->>'audit_context_days')::int FROM settings WHERE key = 'privacy'), 365) * interval '1 day'"));
  // Security events and the addresses tokens were used from, likewise (settings.privacy.security_event_days, #64).
  every(DAY, 'security event cleanup', () => purgeSecurityEvents());
  every(HOUR, 'idempotency key cleanup', () => pruneIdempotencyKeys());
  every(HOUR, 'dev webhook replay cleanup', () => pruneDeliveries());
  every(6 * HOUR, 'webhook delivery cleanup', () => pruneWebhookDeliveries(), { firstAfter: 0 });
  every(DAY, 'notification cleanup', () => pruneNotifications());
  every(DAY, 'status subscription cleanup', () => pruneStatusSubscriptions());
  every(HOUR, 'portal cleanup', () => prunePortal());
  every(HOUR, 'automation log cleanup', () => pruneRuleRuns());
  every(HOUR, 'event purge', () => purgeEvents());
  backfillSla().catch((err) => app.log.warn(`SLA backfill failed: ${err.message}`));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });
