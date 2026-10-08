// The application logger. KERNEL_LOG_FORMAT=ecs writes Elastic Common Schema JSON (for Filebeat / Elastic Agent);
// the default is pino's standard JSON.
import { ecsFormat } from '@elastic/ecs-pino-format';
import pino, { type DestinationStream, type Logger } from 'pino';
import { minimiseData } from './minimise.js';

const FORMAT = () => process.env.KERNEL_LOG_FORMAT ?? 'json';

// Never log credentials: session cookies, bearer tokens (API/MCP) or Set-Cookie, wherever they appear.
const REDACT = [
  'req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', 'headers.cookie', 'headers.authorization',
  'http.request.headers.cookie', 'http.request.headers.authorization', 'http.response.headers["set-cookie"]',
  'password', '*.password', 'token', '*.token', 'secret', '*.secret',
];

// Only safe request/response fields, in ECS shape. Headers are deliberately left out.
const serializers = {
  req: (req: any) => ({ method: req.method, url: req.url, remoteAddress: req.ip ?? req.socket?.remoteAddress }),
  res: (res: any) => ({ statusCode: res.statusCode }),
};

export function createLogger(options: { level?: string; format?: string; dataset?: string; destination?: DestinationStream } = {}): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  const format = options.format ?? FORMAT();
  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'kernel';
  const common = { level, redact: { paths: REDACT, censor: '[REDACTED]' }, serializers };
  const base =
    format === 'ecs'
      ? { ...ecsFormat({ convertReqRes: false, serviceName, eventDataset: options.dataset ?? serviceName }), ...common }
      : { ...common, ...(options.dataset ? { base: { dataset: options.dataset } } : {}) };
  return options.destination ? pino(base, options.destination) : pino(base);
}

export const logger = createLogger();
// Domain events get their own event.dataset so they can be routed to their own data stream.
const domainLogger = createLogger({ dataset: 'kernel.problem', level: 'info' });

/**
 * Logs a problem management domain event (event.dataset "kernel.problem"), so the process itself can be
 * charted in Kibana next to the system telemetry.
 */
export function logDomainEvent(e: {
  action: string;
  problem: { ref: string; status: string; priority: number; is_major?: boolean; category?: string | null; service?: string };
  actor?: string | null;
  summary: string;
  data?: Record<string, unknown>;
}) {
  domainLogger.info(
    {
      event: { kind: 'event', category: ['process'], action: e.action },
      problem: {
        ref: e.problem.ref,
        status: e.problem.status,
        priority: e.problem.priority,
        is_major: e.problem.is_major ?? false,
        ...(e.problem.category ? { category: e.problem.category } : {}),
        ...(e.problem.service ? { service: e.problem.service } : {}),
        ...(e.data ? { change: minimiseData(e.data) } : {}),
      },
      ...(e.actor ? { user: { name: e.actor } } : {}),
    },
    e.summary,
  );
}

const auditLogger = createLogger({ dataset: 'kernel.audit', level: 'info' });

/**
 * Administrative actions (webhooks today). An interim audit trail until the unified audit log (#57);
 * values that are secrets must never be passed here.
 */
export function auditLog(actor: { id: number; username: string } | null, action: string, details: Record<string, unknown>) {
  auditLogger.info({ event: { kind: 'event', category: ['configuration'], action }, user: actor ? { id: actor.id, name: actor.username } : undefined, details }, action);
}
