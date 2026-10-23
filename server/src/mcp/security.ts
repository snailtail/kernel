// MCP: The audit trail and security events (administrators).
import { z } from 'zod';
import { auditQuerySchema, queryAudit } from '../audit.js';
import * as events from '../events.js';
import { alertingStatus } from '../security-alerts.js';
import { querySecurityEvents, SECURITY_CATEGORIES, SECURITY_OUTCOMES, securityQuerySchema } from '../security-events.js';
import { type McpContext } from './registrar.js';

export function registerSecurityTools({ tool }: McpContext) {
  {
    tool(
      'query_audit_log',
      'Search the audit trail across everything (admins): filter by actor (name) or actor_id, actor_type (user, api_token, mcp, integration, system, anonymous), token_prefix (everything one token did), entity_type (problem, user, api_token, webhook, session, setting…), entity_ref, action, date range or IP.',
      {
        actor: z.string().optional(),
        actor_id: z.number().int().optional(),
        token_prefix: z.string().optional(),
        actor_type: z.string().optional(),
        entity_type: z.string().optional(),
        entity_ref: z.string().optional(),
        action: z.string().optional(),
        from: z.string().optional().describe('YYYY-MM-DD'),
        to: z.string().optional().describe('YYYY-MM-DD'),
        ip: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      true,
      async (args) => queryAudit(auditQuerySchema.parse({ ...args, limit: args.limit ?? 100 })),
    );
    tool(
      'query_security_events',
      'Search security events (admins): sign-ins and failed sign-ins, lock-outs, denied requests, invalid tokens, token use from a new address, role and credential changes, exports and reveals, CSP reports, rate limits, invalid webhook signatures and blocked outbound requests. Filter by action, category, outcome, minimum severity, user, IP, token prefix, target or date range.',
      {
        action: z.string().optional().describe('e.g. auth.login_failed, authz.denied, user.update'),
        category: z.enum(SECURITY_CATEGORIES).optional(),
        outcome: z.enum(SECURITY_OUTCOMES).optional(),
        min_severity: z.enum(['info', 'warning', 'minor', 'major', 'critical']).optional(),
        user: z.string().optional(),
        ip: z.string().optional(),
        token_prefix: z.string().optional(),
        target: z.string().optional(),
        from: z.string().optional().describe('YYYY-MM-DD'),
        to: z.string().optional().describe('YYYY-MM-DD'),
        limit: z.number().int().min(1).max(500).optional(),
      },
      true,
      async (args) => querySecurityEvents(securityQuerySchema.parse({ ...args, limit: args.limit ?? 100 })),
    );
    tool(
      'get_security_alerting',
      `Security alerting (admins): the detection rules over security events (failed sign-ins, denied requests, bulk exports, a sign-in from a new country, a new administrator, changed credentials) with their thresholds, the event rule that turns them into restricted security incidents, and the open security alerts (source "${events.SECURITY_SOURCE}").`,
      {},
      true,
      () => alertingStatus(),
    );
  }
}
