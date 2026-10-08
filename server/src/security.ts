// HTTP hardening (security headers, CSP, CSRF origin checks) and the security status checklist.
import helmet from '@fastify/helmet';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { backupStatus } from './backups.js';
import { config } from './config.js';
import { query } from './db.js';
import { forbidden } from './errors.js';
import { logger } from './log.js';
import { rateLimit } from './ratelimit.js';
import { secretsConfigured } from './secrets.js';

const securityLog = logger.child({ event: { dataset: 'kernel.security' } });

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
  app.addHook('onSend', async (req, reply) => {
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    if (req.url.startsWith('/api/') || req.url.startsWith('/mcp')) reply.header('Cache-Control', 'no-store');
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
    securityLog.warn(
      {
        event: { action: 'csp.violation', category: ['web'] },
        csp: {
          directive: pick('effective-directive', 'effectiveDirective', 'violated-directive'),
          blocked: pick('blocked-uri', 'blockedURL'),
          document: pick('document-uri', 'documentURL'),
        },
        source: { ip: req.ip },
      },
      'Content Security Policy violation',
    );
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
  const [admins, mustChange, neverExpiring, backups, mfaAdmins] = await Promise.all([
    query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active"),
    query('SELECT count(*)::int AS n FROM users WHERE must_change_password AND active'),
    query('SELECT count(*)::int AS n FROM api_tokens WHERE expires_at IS NULL'),
    backupStatus(),
    query("SELECT count(*) FILTER (WHERE mfa_enabled_at IS NULL)::int AS without, count(*)::int AS total FROM users WHERE active AND role IN ('admin', 'problem_manager')"),
  ]);
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
      { id: 'secret_key', label: 'Secrets encryption key', ok: secretsConfigured(), detail: secretsConfigured() ? 'KERNEL_SECRET_KEY is set; stored secrets are encrypted.' : 'Set KERNEL_SECRET_KEY (≥ 32 random characters).' },
      { id: 'initial_password', label: 'Initial passwords changed', ok: mustChange.rows[0].n === 0, detail: mustChange.rows[0].n ? `${mustChange.rows[0].n} account(s) still use a generated password.` : 'No account uses a generated password.' },
      {
        id: 'mfa',
        label: 'Two-factor authentication',
        ok: m.without === 0,
        detail: m.without ? `${m.without} of ${m.total} administrators/problem managers have no two-factor authentication. Require it under Two-factor policy.` : 'All administrators and problem managers use two-factor authentication.',
      },
      { id: 'admins', label: 'Administrators', ok: admins.rows[0].n >= 1 && admins.rows[0].n <= 3, detail: `${admins.rows[0].n} active administrator(s); keep it small but more than one person able to recover.` },
      { id: 'tokens', label: 'API tokens expire', ok: neverExpiring.rows[0].n === 0, detail: neverExpiring.rows[0].n ? `${neverExpiring.rows[0].n} token(s) never expire; revoke and recreate them with an expiry.` : 'All tokens have an expiry date.' },
      { id: 'backups', label: 'Backups', ok: backups.configured ? !!backups.healthy : false, detail: backups.configured ? (backups.healthy ? 'Recent successful backup.' : 'No recent successful backup.') : 'No backup directory configured.' },
      { id: 'outbound', label: 'Outbound requests', ok: true, detail: process.env.KERNEL_OUTBOUND_ALLOW ? `Private ranges allowed: ${process.env.KERNEL_OUTBOUND_ALLOW}` : 'Webhooks cannot reach private networks.' },
      { id: 'headers', label: 'Security headers and CSP', ok: true, detail: 'Strict Content Security Policy, HSTS, frame denial, no-store on API responses.' },
    ],
  };
}

/** Configuration warnings at startup; misconfigurations that would weaken security refuse to start. */
export function checkConfiguration(log: (msg: string) => void) {
  const key = process.env.KERNEL_SECRET_KEY;
  if (key && key.length < 32) throw new Error('KERNEL_SECRET_KEY must be at least 32 characters');
  if (process.env.NODE_ENV === 'production') {
    if (!key) log('Security: KERNEL_SECRET_KEY is not set; webhooks and other secrets cannot be stored.');
    if (!config.secureCookies && !/^https:/i.test(config.publicUrl ?? '')) log('Security: KERNEL_PUBLIC_URL is not an https:// address and KERNEL_SECURE_COOKIES is not set; serve Kernel over HTTPS in production.');
    if ((process.env.LOG_LEVEL ?? '').match(/debug|trace/)) log('Security: debug logging is enabled; do not use it in production.');
  }
}
