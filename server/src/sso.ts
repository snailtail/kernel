// Single sign-on (#41). OpenID Connect with the authorization code flow, PKCE, one-time state and a nonce (no
// implicit flow); the ID token's issuer, audience, expiry and nonce are checked by openid-client against the provider's
// published keys. Groups map to roles – administrator only when a group is explicitly mapped to it – and to teams.
// Users are created on first sign-in and linked to their person record. Cloudflare Access can sign people in too.
import * as client from 'openid-client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { User } from './auth.js';
import { createSession, hashPassword } from './auth.js';
import { createChallenge } from './mfa.js';
import { audit } from './audit.js';
import { config } from './config.js';
import { asSystem } from './context.js';
import { query, tx } from './db.js';
import { badRequest, forbidden, HttpError, unauthorized } from './errors.js';
import { securityEvent } from './security-events.js';
import { outboundFetch } from './outbound.js';
import { createPortalSession } from './portal.js';
import { moduleEnabled } from './modules.js';
import { authorize } from './policy.js';
import { decryptSecret, encryptSecret } from './secrets.js';

/** A second-factor challenge waiting after SSO (cookie, path /api/auth, five minutes). */
export const MFA_PENDING_COOKIE = 'kernel_mfa_pending';

const ROLES = ['viewer', 'analyst', 'problem_manager', 'admin'] as const;
type Role = (typeof ROLES)[number];

export const ssoSchema = z.object({
  enabled: z.boolean(),
  issuer: z.string().trim().url().max(500),
  client_id: z.string().trim().min(1).max(300),
  client_secret: z.string().max(2000).optional(),
  scopes: z.string().trim().max(300).default('openid profile email'),
  groups_claim: z.string().trim().max(100).default('groups'),
  role_map: z.array(z.object({ group: z.string().trim().min(1).max(300), role: z.enum(ROLES) })).max(100).default([]),
  team_map: z.array(z.object({ group: z.string().trim().min(1).max(300), team_id: z.number().int() })).max(200).default([]),
  /** Role for people in no mapped group; null refuses them. Never admin. */
  default_role: z.enum(['viewer', 'analyst']).nullable().default(null),
  /** Who may still sign in with a password once SSO is on: everyone, or administrators only (break-glass). */
  local_login: z.enum(['all', 'admins']).default('all'),
  label: z.string().trim().max(60).default('Sign in with SSO'),
  /**
   * Accept the provider's second factor instead of Kernel's TOTP – only with evidence in the ID token: "mfa" in amr
   * (Entra, Okta, Keycloak) or an acr in mfa_acr_values. Off by default.
   */
  trust_idp_mfa: z.boolean().default(false),
  mfa_acr_values: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  private_allow: z.array(z.string().max(100)).max(20).default([]),
  /**
   * Accept an email claim the provider does not mark as verified (no email_verified at all). Off by default: the portal
   * signs people in by email alone, and some providers let users set their own (Entra's "nOAuth"). false is never accepted.
   */
  trust_email_claim: z.boolean().default(false),
});
type SsoSettings = z.infer<typeof ssoSchema> & { client_secret_enc?: string | null };

export async function ssoSettings(): Promise<SsoSettings> {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'sso'");
  return rows[0]?.value ?? { enabled: false };
}

const redirectUri = () => `${(config.publicUrl ?? '').replace(/\/$/, '')}/api/auth/sso/callback`;

let discovered: { key: string; at: number; config: client.Configuration } | null = null;

/** The provider's configuration (discovery document and keys), cached for ten minutes; all HTTP via outboundFetch. */
async function providerConfig(s: SsoSettings) {
  const key = `${s.issuer}|${s.client_id}`;
  if (discovered && discovered.key === key && Date.now() - discovered.at < 600_000) return discovered.config;
  const secret = s.client_secret_enc ? decryptSecret(s.client_secret_enc) : undefined;
  const fetchVia = (async (url: string, init: { method?: string; headers?: Record<string, string> | Headers; body?: unknown }) => {
    const headers = Object.fromEntries(new Headers(init?.headers as HeadersInit).entries());
    const res = await outboundFetch(String(url), { method: init?.method ?? 'GET', headers, body: init?.body == null ? undefined : String(init.body), timeoutMs: 10_000, maxBytes: 1_000_000, privateAllow: s.private_allow?.length ? s.private_allow : undefined });
    return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const options = { [client.customFetch]: fetchVia, ...(s.issuer.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : {}) };
  const cfg = await client.discovery(new URL(s.issuer), s.client_id, secret ? { client_secret: secret } : undefined, secret ? undefined : client.None(), options as any);
  cfg[client.customFetch] = fetchVia as any;
  if (s.issuer.startsWith('http://')) client.allowInsecureRequests(cfg); // only for an http issuer (labs, tests)
  discovered = { key, at: Date.now(), config: cfg };
  return cfg;
}

/** Starts sign-in: one-time state, nonce and PKCE verifier stored server-side, then off to the provider. */
export async function startSso(req: FastifyRequest, reply: FastifyReply, purpose: 'kernel' | 'portal' = 'kernel') {
  const s = await ssoSettings();
  if (!s.enabled) throw new HttpError(404, 'Single sign-on is not set up');
  const cfg = await providerConfig(s);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const verifier = client.randomPKCECodeVerifier();
  const ret = String((req.query as any)?.return ?? '/');
  const returnTo = purpose === 'portal' ? '/portal' : /^\/(?![/\\])[\w\-./?=&%#]*$/.test(ret) ? ret : '/';
  await query("DELETE FROM sso_requests WHERE created_at < now() - interval '10 minutes'");
  const stepUp = purpose === 'kernel' && (req.query as any)?.prompt === 'login';
  await query('INSERT INTO sso_requests (state, nonce, code_verifier, return_to, step_up, purpose) VALUES ($1, $2, $3, $4, $5, $6)', [state, nonce, verifier, returnTo, stepUp, purpose]);
  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: redirectUri(), scope: s.scopes, state, nonce, response_type: 'code',
    code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
    ...(stepUp ? { prompt: 'login', max_age: '0' } : {}),
  });
  return reply.redirect(url.href);
}

/**
 * The provider's email when it may identify a person: email_verified must be true, or absent with trust_email_claim
 * on. It decides who you are in the portal (#45) and which person a new account is linked to.
 */
export function verifiedEmail(claims: Record<string, unknown>, s: Pick<SsoSettings, 'trust_email_claim'>) {
  if (typeof claims.email !== 'string' || !claims.email.trim()) return '';
  const ok = claims.email_verified === true || (claims.email_verified === undefined && s.trust_email_claim === true);
  return ok ? claims.email.trim().toLowerCase() : '';
}

const RANK: Record<Role, number> = { viewer: 0, analyst: 1, problem_manager: 2, admin: 3 };

/** The role from groups: the highest explicitly mapped role, else the default (never admin), else no access. */
export function roleFor(groups: string[], s: Pick<SsoSettings, 'role_map' | 'default_role'>): Role | null {
  const mapped = s.role_map.filter((m) => groups.includes(m.group)).map((m) => m.role);
  if (mapped.length) return mapped.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
  return s.default_role ?? null;
}

/** The provider's answer: checks state (once), exchanges the code with the PKCE verifier, validates the ID token. */
export async function finishSso(req: FastifyRequest, reply: FastifyReply) {
  const s = await ssoSettings();
  if (!s.enabled) throw new HttpError(404, 'Single sign-on is not set up');
  const q = req.query as Record<string, string>;
  const { rows } = await query("DELETE FROM sso_requests WHERE state = $1 AND created_at > now() - interval '10 minutes' RETURNING nonce, code_verifier, return_to, step_up, purpose, created_at", [String(q.state ?? '')]);
  if (!rows[0]) throw badRequest('This sign-in has expired or was already used. Start again.');
  const cfg = await providerConfig(s);
  const current = new URL(`${redirectUri()}?${new URLSearchParams(q).toString()}`);
  let claims: Record<string, unknown>;
  try {
    const tokens = await client.authorizationCodeGrant(cfg, current, { pkceCodeVerifier: rows[0].code_verifier, expectedState: String(q.state), expectedNonce: rows[0].nonce, idTokenExpected: true });
    claims = (tokens.claims() ?? {}) as Record<string, unknown>;
  } catch (err) {
    securityEvent({ action: 'auth.sso_failed', category: 'authentication', outcome: 'failure', message: 'Single sign-on failed', detail: { error: (err as Error).message.slice(0, 200) } });
    throw unauthorized('Single sign-on failed. Try again, or ask an administrator.');
  }
  // A step-up counts only if the provider really authenticated the person again after it started.
  if (rows[0].step_up) {
    const authTime = Number(claims.auth_time ?? 0) * 1000;
    if (!authTime || authTime < new Date(rows[0].created_at).getTime() - 5_000) {
      securityEvent({ action: 'auth.sso_step_up_refused', category: 'authentication', outcome: 'failure', message: 'SSO step-up without a fresh authentication' });
      throw unauthorized('Your identity provider did not ask you to sign in again. Confirm with your password instead, or ask an administrator.');
    }
  }
  // A portal sign-in (#45) is a person, not a Kernel account: no groups or roles, and no user is created.
  if (rows[0].purpose === 'portal') return portalSignIn(req, reply, claims, s);
  const amr = Array.isArray(claims.amr) ? (claims.amr as unknown[]).map(String) : [];
  const idpMfa = s.trust_idp_mfa === true && (amr.includes('mfa') || (typeof claims.acr === 'string' && (s.mfa_acr_values ?? []).includes(claims.acr)));
  const groups = Array.isArray(claims[s.groups_claim]) ? (claims[s.groups_claim] as unknown[]).map(String) : [];
  const role = roleFor(groups, s);
  if (!role) {
    securityEvent({ action: 'auth.sso_denied', category: 'authorization', outcome: 'denied', message: 'SSO user in no mapped group' });
    throw forbidden('Your account is not in a group that may use Kernel. Ask an administrator.');
  }
  const user = await asSystem(() => provisionUser(String(claims.iss), String(claims.sub), {
    email: typeof claims.email === 'string' && claims.email_verified !== false ? claims.email : '',
    verified_email: verifiedEmail(claims, s),
    name: String(claims.name ?? claims.preferred_username ?? claims.email ?? claims.sub),
    username: String(claims.preferred_username ?? claims.email ?? `sso-${String(claims.sub).slice(0, 12)}`),
  }, role, groups, s));
  // Kernel's own second factor still applies unless the provider's MFA is accepted with evidence.
  if (user.mfa_enabled && !idpMfa) {
    // The pending second-factor challenge travels in a short-lived httpOnly cookie, never in the URL.
    reply.setCookie(MFA_PENDING_COOKIE, await createChallenge(user.id), { path: '/api/auth', httpOnly: true, sameSite: 'lax', secure: config.secureCookies || req.protocol === 'https', maxAge: 300 });
    return reply.redirect('/');
  }
  await createSession(req, reply, user.id, 'sso', idpMfa);
  await audit(null, { entity_type: 'session', entity_ref: `#${user.id}`, action: 'login', changes: { method: 'sso', role, idp_mfa: idpMfa }, actor: { id: user.id, name: user.username } });
  return reply.redirect(rows[0].return_to || '/');
}

/**
 * The portal's single sign-on: the provider's verified email (verifiedEmail) must belong to exactly one active person
 * in people. No sign-up and no Kernel account.
 */
async function portalSignIn(req: FastifyRequest, reply: FastifyReply, claims: Record<string, unknown>, s: SsoSettings) {
  const email = verifiedEmail(claims, s);
  const { rows } = moduleEnabled('portal') && email
    ? await query("SELECT id FROM people WHERE lower(email) = $1 AND active AND erased_at IS NULL", [email])
    : { rows: [] as any[] };
  if (rows.length !== 1) {
    securityEvent({ action: 'portal.sso_refused', category: 'authentication', outcome: 'denied', message: 'Portal single sign-on for an address that is not a known person' }, req);
    return reply.redirect('/portal?signin=unknown');
  }
  await createPortalSession(req, reply, rows[0].id, 'sso');
  return reply.redirect('/portal');
}

/** Just-in-time account: created on first sign-in, role and mapped teams kept in step with the provider's groups. */
async function provisionUser(issuer: string, subject: string, p: { email: string; verified_email: string; name: string; username: string }, role: Role, groups: string[], s: SsoSettings) {
  return tx(async (db) => {
    const { rows: found } = await db.query('SELECT id, username, role, mfa_enabled_at IS NOT NULL AS mfa_enabled FROM users WHERE sso_issuer = $1 AND sso_subject = $2', [issuer, subject]);
    let id: number;
    let username: string;
    const mfaEnabled = !!found[0]?.mfa_enabled;
    if (found[0]) {
      ({ id, username } = found[0]);
      if (found[0].role !== role) {
        await db.query('UPDATE users SET role = $2 WHERE id = $1', [id, role]);
        await audit(db, { entity_type: 'user', entity_ref: `#${id}`, action: 'update', changes: { role: { from: found[0].role, to: role }, via: 'sso groups' } });
      }
      await db.query('UPDATE users SET display_name = $2, email = $3 WHERE id = $1', [id, p.name.slice(0, 200), p.email.slice(0, 200)]);
    } else {
      // Never attach to an existing local account by e-mail: a new SSO identity gets its own account.
      const base = p.username.toLowerCase().replace(/[^a-z0-9._@-]/g, '').slice(0, 60) || 'sso-user';
      const { rows: taken } = await db.query('SELECT username FROM users WHERE username = $1 OR username LIKE $1 || $2', [base, '-%']);
      username = taken.length ? `${base}-${taken.length + 1}` : base;
      const unusable = await hashPassword(randomBytes(32).toString('base64'));
      const { rows } = await db.query(
        'INSERT INTO users (username, display_name, email, role, password_hash, sso_issuer, sso_subject) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [username, p.name.slice(0, 200), p.email.slice(0, 200), role, unusable, issuer, subject],
      );
      id = rows[0].id;
      await audit(db, { entity_type: 'user', entity_ref: `#${id}`, action: 'create', changes: { role, via: 'sso' } });
      // Link to the person record with the same e-mail (#39), only when the provider vouches for it (verifiedEmail).
      if (p.verified_email) await db.query('UPDATE people SET user_id = $1 WHERE lower(email) = lower($2) AND user_id IS NULL AND erased_at IS NULL', [id, p.verified_email]);
    }
    // Mapped teams follow the groups; teams that are not mapped are left alone.
    for (const m of s.team_map) {
      if (groups.includes(m.group)) await db.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [m.team_id, id]);
      else await db.query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2 AND role = 'member'", [m.team_id, id]);
    }
    return { id, username, mfa_enabled: mfaEnabled };
  });
}

// ---- Cloudflare Access ---------------------------------------------------------------------------------------------

let jwks: { domain: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null;

/**
 * Behind Cloudflare Access, people have already signed in there. Kernel verifies the Access JWT (signature from the
 * team's published keys, issuer, audience, expiry) and starts a session for the existing account with that e-mail.
 */
export async function accessLogin(req: FastifyRequest, reply: FastifyReply) {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'cf_access'");
  const s = rows[0]?.value as { enabled: boolean; team_domain: string; audience: string } | undefined;
  if (!s?.enabled) throw new HttpError(404, 'Cloudflare Access sign-in is not set up');
  // Same-origin only (like every cookie-authenticated change), so another site cannot sign someone in.
  if (!req.headers['x-kernel-request']) throw forbidden('Missing X-Kernel-Request header');
  const token = req.headers['cf-access-jwt-assertion'];
  if (typeof token !== 'string' || !token) throw unauthorized('No Cloudflare Access token');
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(s.team_domain)) throw new HttpError(500, 'The Cloudflare Access team domain is not valid');
  // KERNEL_TEST_CF_CERTS_URL lets the tests serve the keys locally; it is never set in a deployment.
  const certs = (process.env.NODE_ENV === 'test' && process.env.KERNEL_TEST_CF_CERTS_URL) || `https://${s.team_domain}/cdn-cgi/access/certs`;
  if (!jwks || jwks.domain !== certs) jwks = { domain: certs, set: createRemoteJWKSet(new URL(certs)) };
  let email: string;
  try {
    const { payload } = await jwtVerify(token, jwks.set, { issuer: `https://${s.team_domain}`, audience: s.audience });
    email = String(payload.email ?? '');
  } catch {
    throw unauthorized('The Cloudflare Access token is not valid');
  }
  const { rows: users } = await query(
    "SELECT id, username, role, sso_subject IS NOT NULL AS sso, allow_access_login, mfa_enabled_at IS NOT NULL AS mfa_enabled FROM users WHERE lower(email) = lower($1) AND active AND email <> ''",
    [email],
  );
  const u = users[0];
  if (!u || !email) throw forbidden('No Kernel account has this e-mail address. Ask an administrator.');
  // Access replaces only the first factor (its policy may be an e-mail code). Local administrator accounts are the
  // break-glass path and are never opened this way unless an administrator allowed it for that account.
  if (u.role === 'admin' && !u.sso && !u.allow_access_login) throw forbidden('Administrator accounts sign in with their password here.');
  if (u.mfa_enabled) return { mfa_required: true, mfa_token: await createChallenge(u.id) };
  await createSession(req, reply, u.id, 'access');
  await audit(null, { entity_type: 'session', entity_ref: `#${u.id}`, action: 'login', changes: { method: 'cloudflare_access' }, actor: { id: u.id, name: u.username } });
  return { ok: true };
}

// ---- Administration ------------------------------------------------------------------------------------------------

export async function getSsoAdmin(user: User) {
  authorize(user, 'mfa.policy');
  const s = await ssoSettings();
  const { rows } = await query("SELECT value FROM settings WHERE key = 'cf_access'");
  const { client_secret_enc, ...shown } = s as SsoSettings;
  return { sso: { ...shown, has_secret: !!client_secret_enc, redirect_uri: redirectUri() }, cf_access: rows[0]?.value };
}

export async function saveSso(user: User, input: z.infer<typeof ssoSchema>, reason: string) {
  authorize(user, 'mfa.policy');
  if (!config.publicUrl) throw badRequest('Set KERNEL_PUBLIC_URL first: the provider needs the exact redirect URL');
  const current = await ssoSettings();
  const { client_secret, ...rest } = input;
  const value = { ...rest, client_secret_enc: client_secret === undefined ? current.client_secret_enc ?? null : client_secret ? encryptSecret(client_secret) : null };
  await query("INSERT INTO settings (key, value) VALUES ('sso', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify(value)]);
  discovered = null;
  await audit(null, { entity_type: 'setting', entity_ref: 'sso', action: 'update', changes: { ...rest, secret_changed: client_secret !== undefined }, reason });
  return getSsoAdmin(user);
}

export const cfAccessSchema = z.object({ enabled: z.boolean(), team_domain: z.string().trim().regex(/^[a-z0-9-]+\.cloudflareaccess\.com$/, 'e.g. myteam.cloudflareaccess.com'), audience: z.string().trim().min(10).max(200) });

export async function saveCfAccess(user: User, input: z.infer<typeof cfAccessSchema>, reason: string) {
  authorize(user, 'mfa.policy');
  await query("INSERT INTO settings (key, value) VALUES ('cf_access', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify(input)]);
  jwks = null;
  await audit(null, { entity_type: 'setting', entity_ref: 'cf_access', action: 'update', changes: input, reason });
  return getSsoAdmin(user);
}

/** For the login page: which sign-in options to offer (nothing secret). */
export async function loginOptions() {
  const s = await ssoSettings();
  const { rows } = await query("SELECT value FROM settings WHERE key = 'cf_access'");
  return { sso: s.enabled ? { label: s.label } : null, cf_access: !!rows[0]?.value?.enabled, local_login: s.enabled ? s.local_login : 'all' };
}
