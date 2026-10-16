// HTTP hardening (security headers, CSP, CSRF origin checks) and the security status checklist.
import helmet from '@fastify/helmet';
import rateLimit_ from '@fastify/rate-limit';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { backupStatus } from './backups.js';
import { config } from './config.js';
import { query } from './db.js';
import { forbidden, HttpError } from './errors.js';
import { securityEvent } from './security-events.js';
import { rateLimit } from './ratelimit.js';
import { lastChainVerification } from './audit.js';
import { storageUse } from './attachments.js';
import { secretsConfigured } from './secrets.js';
import { activeKey, keyring } from './keys.js';
import { keyUsage } from './rotate-keys.js';


// Applied to the root instance (not as an encapsulated plugin) so headers and hooks cover every route.
export async function registerSecurity(app: FastifyInstance<any, any, any, any>) {
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        // React sets a few dynamic style attributes (chart bar widths, tooltip position); no inline <style>/<script>.
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        reportUri: ['/api/csp-report'],
      },
    },
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  // A ceiling per caller on the whole API (#66): a runaway script or a stolen token cannot exhaust the server. Keyed
  // on the session or token (hashed), else the client address; event ingestion gets a higher ceiling for bursts.
  const perMinute = Number(process.env.KERNEL_RATE_LIMIT_PER_MINUTE ?? 1200);
  const INGEST = /^\/api\/(events|cmdb\/ci-batch|integrations\/records|cis\/upsert)(\?|$)/;
  await app.register(rateLimit_, {
    global: true,
    timeWindow: 60_000,
    max: (req) => (INGEST.test(req.url) ? perMinute * 5 : perMinute),
    allowList: (req) => req.url === '/healthz' || !(req.url.startsWith('/api/') || req.url.startsWith('/mcp')),
    keyGenerator: (req) => {
      const auth = req.headers.authorization ?? /(?:^|;\s*)kernel_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      return auth ? `c:${createHash('sha256').update(auth).digest('hex').slice(0, 32)}` : `ip:${req.ip}`;
    },
    errorResponseBuilder: (_req, ctx) => new HttpError(429, 'Too many requests, try again later', { retry_after_seconds: Math.ceil(ctx.ttl / 1000) }),
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    // Everything is private and uncached, except the public status page (cacheable, published data only).
    if ((req.url.startsWith('/api/') && !req.url.startsWith('/api/public/')) || req.url.startsWith('/mcp')) reply.header('Cache-Control', 'no-store');
  });

  // Browsers report CSP violations here; they are logged as security events.
  for (const type of ['application/csp-report', 'application/reports+json']) {
    app.addContentTypeParser(type, { parseAs: 'string', bodyLimit: 16_384 }, (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(null, {});
      }
    });
  }
  app.post('/api/csp-report', async (req, reply) => {
    rateLimit(`csp:${req.ip}`, 30, 60_000);
    const body = req.body as any;
    const report = (Array.isArray(body) ? body[0]?.body : body?.['csp-report'] ?? body?.body ?? body) ?? {};
    const pick = (...keys: string[]) => {
      for (const k of keys) if (typeof report[k] === 'string') return report[k].slice(0, 200);
      return undefined;
    };
    // Only the key fields, truncated: reports are attacker-controllable input.
    securityEvent({
      action: 'web.csp_violation',
      category: 'web',
      outcome: 'blocked',
      message: 'Content Security Policy violation',
      detail: {
        directive: pick('effective-directive', 'effectiveDirective', 'violated-directive'),
        blocked: pick('blocked-uri', 'blockedURL'),
        document: pick('document-uri', 'documentURL'),
      },
    }, req);
    reply.code(204);
  });
}

/**
 * CSRF defence in depth for cookie-authenticated writes (bearer requests are exempt): the browser's Origin /
 * Sec-Fetch-Site must say the request comes from this site, besides SameSite=Lax and the X-Kernel-Request header.
 */
export function checkSameOrigin(req: FastifyRequest) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw forbidden('Cross-site request rejected');
  const origin = req.headers.origin;
  if (origin) {
    // X-Forwarded-Host may list several hops; the first is the client-facing host.
    const forwarded = config.trustProxy ? String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim() : '';
    const host = forwarded || req.headers.host;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw forbidden('Invalid Origin header');
    }
    if (originHost !== host) throw forbidden('Cross-origin request rejected');
  }
}

export interface SecurityCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

/** A checklist of the security-relevant configuration, for the admin Security page. */
export async function securityStatus(): Promise<{ checks: SecurityCheck[] }> {
  const [admins, mustChange, neverExpiring, backups, mfaAdmins, dbRole, legacyAudit, attachmentUse, breakGlass] = await Promise.all([
    query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active"),
    query('SELECT count(*)::int AS n FROM users WHERE must_change_password AND active'),
    query('SELECT count(*)::int AS n FROM api_tokens WHERE expires_at IS NULL'),
    backupStatus(),
    query("SELECT count(*) FILTER (WHERE mfa_enabled_at IS NULL)::int AS without, count(*)::int AS total FROM users WHERE active AND role IN ('admin', 'problem_manager')"),
    query(`SELECT current_user AS me, (SELECT tableowner FROM pg_tables WHERE tablename = 'audit_log') AS owner,
             (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`),
    query("SELECT count(*)::int AS n FROM audit_log WHERE actor_name <> '' OR ip <> ''"),
    storageUse(),
    query('SELECT count(*)::int AS n FROM visibility_breakglass WHERE expires_at > now()'),
  ]);
  const usedPct = Math.round((attachmentUse.bytes / attachmentUse.quota_bytes) * 100);
  // Key rotation (#63): which keys are in use, and whether any is missing from the keyring.
  const usage = await keyUsage();
  const configured = new Set(keyring().map((k) => k.id));
  const inUse = [...new Set([...Object.keys(usage.secrets), ...Object.keys(usage.audit)])];
  const missing = inUse.filter((id) => !configured.has(id));
  const active = activeKey()?.id;
  const stale = Object.keys(usage.secrets).filter((id) => id !== active);
  const keyCheck = {
    id: 'key_rotation',
    label: 'Encryption keys',
    ok: !missing.length && !stale.length,
    detail: missing.length
      ? `Key(s) ${missing.join(', ')} are used by stored data but not configured: add them back to KERNEL_SECRET_KEYS.`
      : stale.length
        ? `Active key ${active}; some secrets still use ${stale.join(', ')}. Run rotate-keys to re-encrypt them.`
        : `Active key ${active ?? '–'}. ${inUse.length ? `In use: ${inUse.map((id) => `${id} (${usage.secrets[id] ?? 0} secrets, ${usage.audit[id] ?? 0} audit entries)`).join('; ')}. Keep keys that audit entries use.` : ''}`,
  };
  const role = dbRole.rows[0];
  const m = mfaAdmins.rows[0];
  // A trusted proxy does not by itself mean TLS; require an https public URL or explicitly secure cookies.
  const https = config.secureCookies || /^https:\/\//i.test(config.publicUrl ?? '');
  return {
    checks: [
      {
        id: 'https',
        label: 'HTTPS',
        ok: https,
        detail: https
          ? 'Kernel is published over HTTPS; session cookies are Secure for HTTPS requests.'
          : 'Set KERNEL_PUBLIC_URL to the https:// address (behind a TLS proxy with KERNEL_TRUST_PROXY) or KERNEL_SECURE_COOKIES=true.',
      },
      {
        id: 'audit_personal_data',
        label: 'Personal data in the audit trail',
        ok: legacyAudit.rows[0].n === 0,
        detail: legacyAudit.rows[0].n
          ? `${legacyAudit.rows[0].n} audit entries from before personal data was kept out of the trail still contain names or IP addresses. Re-basing them is a one-time decision for the database owner; see docs/adr/0001-personal-data-and-the-audit-trail.md.`
          : 'The audit trail stores user ids, digests and codes only; names and IP addresses are kept outside it.',
      },
      {
        id: 'attachment_storage',
        label: 'Attachment storage',
        ok: usedPct < 80,
        detail: `${attachmentUse.files} attachments use ${(attachmentUse.bytes / 1024 ** 3).toFixed(2)} GB of ${(attachmentUse.quota_bytes / 1024 ** 3).toFixed(0)} GB (${usedPct}%). They are stored in the database and included in every backup.`,
      },
      {
        id: 'break_glass',
        label: 'Break-glass access to restricted records',
        ok: breakGlass.rows[0].n === 0,
        detail: breakGlass.rows[0].n ? `${breakGlass.rows[0].n} administrator session(s) can currently open restricted records (one hour each; see the audit trail).` : 'No one is using break-glass access.',
      },
      { id: 'secret_key', label: 'Secrets encryption key', ok: secretsConfigured(), detail: secretsConfigured() ? 'KERNEL_SECRET_KEY is set; stored secrets are encrypted.' : 'Set KERNEL_SECRET_KEY (≥ 32 random characters).' },
      keyCheck,
      { id: 'initial_password', label: 'Initial passwords changed', ok: mustChange.rows[0].n === 0, detail: mustChange.rows[0].n ? `${mustChange.rows[0].n} account(s) still use a generated password.` : 'No account uses a generated password.' },
      {
        id: 'mfa',
        label: 'Two-factor authentication',
        ok: m.without === 0,
        detail: m.without ? `${m.without} of ${m.total} administrators/problem managers have no two-factor authentication. Require it under Two-factor policy.` : 'All administrators and problem managers use two-factor authentication.',
      },
      {
        id: 'db_role',
        label: 'Least-privilege database role',
        ok: role.me !== role.owner && !role.superuser,
        detail:
          role.me !== role.owner && !role.superuser
            ? `Kernel runs as "${role.me}", which cannot change the schema or the audit trail.`
            : `Kernel runs as the table owner "${role.me}"${role.superuser ? ' (a superuser)' : ''}; set KERNEL_APP_DB_PASSWORD so it uses a restricted role.`,
      },
      { id: 'admins', label: 'Administrators', ok: admins.rows[0].n >= 1 && admins.rows[0].n <= 3, detail: `${admins.rows[0].n} active administrator(s); keep it small but more than one person able to recover.` },
      { id: 'tokens', label: 'API tokens expire', ok: neverExpiring.rows[0].n === 0, detail: neverExpiring.rows[0].n ? `${neverExpiring.rows[0].n} token(s) never expire; revoke and recreate them with an expiry.` : 'All tokens have an expiry date.' },
      { id: 'backups', label: 'Backups', ok: backups.configured ? !!backups.healthy : false, detail: backups.configured ? (backups.healthy ? 'Recent successful backup.' : 'No recent successful backup.') : 'No backup directory configured.' },
      { id: 'outbound', label: 'Outbound requests', ok: true, detail: process.env.KERNEL_OUTBOUND_ALLOW ? `Private ranges allowed: ${process.env.KERNEL_OUTBOUND_ALLOW}` : 'Webhooks cannot reach private networks.' },
      { id: 'headers', label: 'Security headers and CSP', ok: true, detail: 'Strict Content Security Policy, HSTS, frame denial, no-store on API responses.' },
      ((v) => ({
        id: 'audit',
        label: 'Audit trail integrity',
        ok: !v || v.ok,
        detail: !v ? 'Not verified yet since start (runs hourly).' : v.ok ? `Hash chain verified ${v.at.slice(0, 16).replace('T', ' ')} UTC (${v.checked} entries).` : `Hash chain broken at entry ${v.broken_at}; investigate immediately.`,
      }))(lastChainVerification()),
    ],
  };
}

/** Configuration warnings at startup; misconfigurations that would weaken security refuse to start. */
export function checkConfiguration(log: (msg: string) => void) {
  const key = process.env.KERNEL_SECRET_KEY;
  if (key && key.length < 32) throw new Error('KERNEL_SECRET_KEY must be at least 32 characters');
  // Test-only hooks must never be active in a deployment.
  if (process.env.NODE_ENV !== 'test' && process.env.KERNEL_TEST_CF_CERTS_URL) throw new Error('KERNEL_TEST_CF_CERTS_URL is for tests only; remove it');
  // A malformed keyring or an unknown active key id stops Kernel here, not at the first secret (#63).
  keyring();
  activeKey();
  if (process.env.NODE_ENV === 'production') {
    if (!key) log('Security: KERNEL_SECRET_KEY is not set; webhooks and other secrets cannot be stored.');
    if (!config.secureCookies && !/^https:/i.test(config.publicUrl ?? '')) log('Security: KERNEL_PUBLIC_URL is not an https:// address and KERNEL_SECURE_COOKIES is not set; serve Kernel over HTTPS in production.');
    if ((process.env.LOG_LEVEL ?? '').match(/debug|trace/)) log('Security: debug logging is enabled; do not use it in production.');
  }
}
