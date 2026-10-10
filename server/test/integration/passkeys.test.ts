import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { Client, PASSWORD, skip, startKernel, type Harness } from './harness.js';

const ORIGIN = 'http://localhost';
const b64 = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');

/** A software authenticator: a P-256 key, user verification on, a signature counter. */
class Authenticator {
  key: KeyObject;
  cose: Uint8Array;
  id = randomBytes(16);
  counter = 0;
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = isoCBOR.encode(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]) as any);
  }
  private authData(flags: number, withCredential: boolean) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const parts = [createHash('sha256').update('localhost').digest(), Buffer.from([flags]), count];
    if (withCredential) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.id.length);
      parts.push(Buffer.alloc(16), len, this.id, Buffer.from(this.cose));
    }
    return Buffer.concat(parts);
  }
  register(challenge: string, origin = ORIGIN) {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
    const attestation = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(0x45, true)]]) as any);
    return { id: b64(this.id), rawId: b64(this.id), type: 'public-key', response: { clientDataJSON: b64(clientData), attestationObject: b64(attestation), transports: ['internal'] }, clientExtensionResults: {}, authenticatorAttachment: 'platform' };
  }
  assert(challenge: string, opts: { uv?: boolean; counter?: number } = {}) {
    this.counter = opts.counter ?? this.counter + 1;
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
    const authData = this.authData(opts.uv === false ? 0x01 : 0x05, false);
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), this.key);
    return { id: b64(this.id), rawId: b64(this.id), type: 'public-key', response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature) }, clientExtensionResults: {} };
  }
}

describe('passkeys and token rotation (#75)', { skip }, () => {
  let k: Harness;
  let pm: Client, admin: Client;
  let db: typeof import('../../src/db.js');
  const device = new Authenticator();

  before(async () => {
    process.env.KERNEL_PUBLIC_URL = ORIGIN;
    k = await startKernel();
    [pm, admin] = await Promise.all([k.login('pm'), k.login('admin')]);
    db = await import('../../src/db.js');
  });
  after(async () => {
    delete process.env.KERNEL_PUBLIC_URL;
    await k?.close();
  });

  const signedIn = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith('kernel_session='))?.split(';')[0];

  test('adding a passkey needs a recent step-up and user verification', async () => {
    await db.query("UPDATE sessions SET reauth_at = now() - interval '1 hour'");
    assert.equal((await pm.post('/api/auth/passkeys/options', {})).status, 403, 'step-up first');
    await pm.post('/api/auth/reauth', { password: PASSWORD });
    const options = (await pm.post('/api/auth/passkeys/options', {})).body;
    assert.equal(options.authenticatorSelection.userVerification, 'required');
    assert.equal(options.rp.id, 'localhost');
    assert.equal((await pm.post('/api/auth/passkeys', { response: device.register(options.challenge, 'https://evil.example'), name: 'Laptop' })).status, 400, 'origin is checked');
    const again = (await pm.post('/api/auth/passkeys/options', {})).body;
    const r = await pm.post('/api/auth/passkeys', { response: device.register(again.challenge), name: 'Laptop' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.map((p: any) => p.name), ['Laptop']);
    assert.equal((await pm.post('/api/auth/passkeys', { response: device.register(again.challenge), name: 'Again' })).status, 401, 'a challenge is single-use');
  });

  test('passwordless sign-in counts as two factors; no user verification, replay or cloning is accepted', async () => {
    await admin.put('/api/admin/mfa-policy', { required_roles: ['problem_manager'], reason: 'Managers need two factors' });
    const login = async (opts: { uv?: boolean; counter?: number } = {}) => {
      const o = await fetch(`${k.base}/api/auth/passkey/options`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json() as any);
      assert.equal(o.userVerification, 'required');
      return fetch(`${k.base}/api/auth/passkey/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ response: device.assert(o.challenge, opts) }) });
    };
    const ok = await login();
    assert.equal(ok.status, 200);
    const cookie = signedIn(ok)!;
    assert.equal((await fetch(`${k.base}/api/problems`, { headers: { Cookie: cookie } })).status, 200, 'MFA satisfied without TOTP');
    assert.equal((await login({ uv: false })).status, 401, 'user verification is required');
    assert.equal((await login({ counter: 1 })).status, 401, 'a counter going backwards means a copied authenticator');
    const { rows } = await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'passkey_clone_suspected'");
    assert.equal(rows[0].n, 1);
    await admin.put('/api/admin/mfa-policy', { required_roles: [], reason: 'Back' });
  });

  test('a passkey as the second factor after the password, and for step-up', async () => {
    const first = await new Client(k.base).post('/api/auth/login', { username: 'pm', password: PASSWORD });
    assert.equal(first.body.mfa_required, true);
    assert.deepEqual(first.body.methods, ['passkey']);
    const o = await fetch(`${k.base}/api/auth/passkey/options`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mfa_token: first.body.mfa_token }) }).then((x) => x.json() as any);
    assert.equal(o.allowCredentials.length, 1, 'only this account\'s passkeys');
    const r = await fetch(`${k.base}/api/auth/passkey/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mfa_token: first.body.mfa_token, response: device.assert(o.challenge) }) });
    assert.equal(r.status, 200);
    const c = new Client(k.base);
    c.cookies.set('kernel_session', signedIn(r)!.split('=')[1]);
    await db.query("UPDATE sessions SET reauth_at = now() - interval '1 hour'");
    assert.equal((await c.post('/api/tokens', { name: 'x' })).status, 403, 'step-up needed');
    const step = (await c.post('/api/auth/reauth/passkey/options', {})).body;
    assert.equal((await c.post('/api/auth/reauth/passkey', { response: device.assert(step.challenge) })).status, 200);
    assert.equal((await c.post('/api/tokens', { name: 'ci', scopes: ['read'] })).status, 200);
  });

  test('a token is rotated with an overlap: both work, the old one for at most a day', async () => {
    await admin.post('/api/auth/reauth', { password: PASSWORD });
    const t = (await admin.post('/api/tokens', { name: 'deploy', scopes: ['read'], expires_in_days: 30 })).body;
    const rotated = (await admin.post(`/api/tokens/${t.id}/rotate`, {})).body;
    assert.match(rotated.token, /^kernel_pat_/);
    assert.notEqual(rotated.token, t.token);
    for (const tok of [t.token, rotated.token]) assert.equal((await new Client(k.base, tok).get('/api/problems')).status, 200);
    const { rows } = await db.query('SELECT expires_at < now() + interval \'25 hours\' AS soon FROM api_tokens WHERE id = $1', [t.id]);
    assert.equal(rows[0].soon, true);
    assert.equal((await admin.post(`/api/tokens/${t.id}/rotate`, {})).status, 404, 'rotated once');
  });
});
