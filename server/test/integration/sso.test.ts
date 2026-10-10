import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('single sign-on (#41)', { skip }, () => {
  let k: Harness;
  let admin: Client, analyst: Client;
  let idp: Server, issuer: string;
  const pending = new Map<string, { challenge: string; nonce: string }>();
  let identity: Record<string, unknown> = {};
  let nonceOverride: string | null = null;

  before(async () => {
    process.env.KERNEL_SECRET_KEY = 'sso-test-key-0123456789abcdefghijklmnop';
    process.env.KERNEL_OUTBOUND_ALLOW = '127.0.0.1';
    process.env.KERNEL_PUBLIC_URL = 'http://kernel.test';
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    // A minimal OpenID provider: discovery, keys, and a token endpoint that checks the PKCE verifier.
    idp = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        const json = (o: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (req.url === '/.well-known/openid-configuration') {
          return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'] });
        }
        if (req.url === '/jwks') return json({ keys: [jwk] });
        if (req.url === '/token') {
          const p = new URLSearchParams(body);
          const code = p.get('code')!;
          const saved = pending.get(code);
          const verifier = p.get('code_verifier') ?? '';
          if (!saved || createHash('sha256').update(verifier).digest('base64url') !== saved.challenge) return json({ error: 'invalid_grant' }, 400);
          pending.delete(code);
          const idToken = await new SignJWT({ nonce: nonceOverride ?? saved.nonce, ...identity }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(issuer).setAudience('kernel').setSubject(String(identity.sub)).setIssuedAt().setExpirationTime('5m').sign(privateKey);
          return json({ access_token: 'at', token_type: 'Bearer', id_token: idToken, expires_in: 300 });
        }
        json({ error: 'not found' }, 404);
      });
    });
    await new Promise<void>((r) => idp.listen(0, '127.0.0.1', () => r()));
    issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
    k = await startKernel();
    [admin, analyst] = await Promise.all([k.login('admin'), k.login('analyst')]);
  });
  after(async () => {
    for (const v of ['KERNEL_SECRET_KEY', 'KERNEL_OUTBOUND_ALLOW', 'KERNEL_PUBLIC_URL']) delete process.env[v];
    await k?.close();
    idp?.close();
  });

  /** The browser's part: start, "sign in" at the provider, come back with a code. */
  async function signIn(who: Record<string, unknown>, opts: { replayState?: boolean } = {}) {
    identity = who;
    const start = await fetch(`${k.base}/api/auth/sso/start`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const auth = new URL(start.headers.get('location')!);
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.get('response_type'), 'code', 'never the implicit flow');
    const code = Math.random().toString(36).slice(2);
    pending.set(code, { challenge: auth.searchParams.get('code_challenge')!, nonce: auth.searchParams.get('nonce')! });
    const url = `${k.base}/api/auth/sso/callback?code=${code}&state=${auth.searchParams.get('state')}&iss=${encodeURIComponent(issuer)}`;
    const res = await fetch(url, { redirect: 'manual' });
    if (opts.replayState) return { res, replay: await fetch(url, { redirect: 'manual' }) };
    return { res };
  }

  test('administrators configure SSO with a group-to-role map; a secret is write-only', async () => {
    const team = (await admin.post('/api/teams', { name: 'Service desk' })).body;
    const r = await admin.put('/api/admin/sso', {
      enabled: true, issuer, client_id: 'kernel', client_secret: 'shh-secret', role_map: [{ group: 'kernel-pm', role: 'problem_manager' }, { group: 'kernel-admins', role: 'admin' }],
      team_map: [{ group: 'servicedesk', team_id: team.id }], default_role: null, reason: 'Sign in with the company directory',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sso.has_secret, true);
    assert.equal(JSON.stringify(r.body).includes('shh-secret'), false);
    assert.equal((await analyst.put('/api/admin/sso', { enabled: false, issuer, client_id: 'x', reason: 'x' })).status, 403);
    assert.deepEqual((await fetch(`${k.base}/api/auth/options`).then((x) => x.json())).sso, { label: 'Sign in with SSO' });
  });

  test('first sign-in creates the account with the mapped role and teams, in a new session', async () => {
    const { res } = await signIn({ sub: 'u-100', email: 'kim@example.com', name: 'Kim Lund', preferred_username: 'kim', groups: ['kernel-pm', 'servicedesk'] });
    assert.equal(res.status, 302, await res.text());
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('kernel_session='))!.split(';')[0];
    const me = await fetch(`${k.base}/api/auth/me`, { headers: { Cookie: cookie } }).then((x) => x.json() as any);
    assert.equal(me.role, 'problem_manager');
    assert.equal(me.display_name, 'Kim Lund');
    const teams = await fetch(`${k.base}/api/my-work`, { headers: { Cookie: cookie } }).then((x) => x.json() as any);
    assert.deepEqual(teams.teams.map((t: any) => t.name), ['Service desk']);
    // Next sign-in without the group: the role follows the provider, the mapped team membership goes.
    const again = await signIn({ sub: 'u-100', email: 'kim@example.com', name: 'Kim Lund', groups: [] });
    assert.equal(again.res.status, 403, 'no mapped group and no default role: no access');
  });

  test('administrator only when a group is explicitly mapped to it; default roles are never admin', async () => {
    const { roleFor } = await import('../../src/sso.js');
    assert.equal(roleFor(['kernel-admins', 'kernel-pm'], { role_map: [{ group: 'kernel-pm', role: 'problem_manager' }, { group: 'kernel-admins', role: 'admin' }], default_role: null }), 'admin');
    assert.equal(roleFor(['other'], { role_map: [{ group: 'kernel-admins', role: 'admin' }], default_role: 'viewer' }), 'viewer');
    assert.equal((await admin.put('/api/admin/sso', { enabled: true, issuer, client_id: 'kernel', default_role: 'admin', reason: 'x' })).status, 400);
  });

  test('state is single-use, and a token with the wrong nonce is refused', async () => {
    const { res, replay } = await signIn({ sub: 'u-200', email: 'ola@example.com', name: 'Ola', groups: ['kernel-pm'] }, { replayState: true });
    assert.equal(res.status, 302);
    assert.equal(replay!.status, 400, 'the same state cannot be used twice');
    nonceOverride = 'not-the-nonce';
    const bad = await signIn({ sub: 'u-201', email: 'eve@example.com', name: 'Eve', groups: ['kernel-admins'] });
    nonceOverride = null;
    assert.equal(bad.res.status, 401);
  });

  test('with local sign-in kept for administrators only, others must use SSO (break-glass admin stays)', async () => {
    await admin.put('/api/admin/sso', { enabled: true, issuer, client_id: 'kernel', role_map: [{ group: 'kernel-pm', role: 'problem_manager' }], local_login: 'admins', reason: 'Directory only' });
    const local = await new Client(k.base).post('/api/auth/login', { username: 'analyst', password: 'correct horse battery' });
    assert.equal(local.status, 403);
    assert.equal((await new Client(k.base).post('/api/auth/login', { username: 'admin', password: 'correct horse battery' })).status, 200);
  });

  test('Cloudflare Access sign-in is off until configured and needs a valid token', async () => {
    assert.equal((await fetch(`${k.base}/api/auth/access`, { method: 'POST' })).status, 404);
    assert.equal((await admin.put('/api/admin/cf-access', { enabled: true, team_domain: 'evil.example.com', audience: 'x'.repeat(20), reason: 'x' })).status, 400);
    await admin.put('/api/admin/cf-access', { enabled: true, team_domain: 'acme.cloudflareaccess.com', audience: 'a'.repeat(64), reason: 'Behind Access' });
    assert.equal((await fetch(`${k.base}/api/auth/access`, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': 'x' } })).status, 403, 'same-origin only');
    assert.equal((await fetch(`${k.base}/api/auth/access`, { method: 'POST', headers: { 'X-Kernel-Request': '1' } })).status, 401);
    assert.equal((await fetch(`${k.base}/api/auth/access`, { method: 'POST', headers: { 'X-Kernel-Request': '1', 'Cf-Access-Jwt-Assertion': 'not.a.jwt' } })).status, 401);
  });
});
