import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { skip, startKernel, type Client, type Harness } from './harness.js';

const K0 = 'original-key-0123456789abcdefghijklmnopqrstu';
const K1 = 'rotated-key-0123456789abcdefghijklmnopqrstuvw';

describe('key rotation (#63)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client;
  let secrets: typeof import('../../src/security/secrets.js');
  let rot: typeof import('../../src/security/rotate-keys.js');
  let audit: typeof import('../../src/security/audit.js');
  let db: typeof import('../../src/core/db.js');

  before(async () => {
    process.env.KERNEL_SECRET_KEY = K0;
    k = await startKernel();
    [admin, pm] = await Promise.all([k.login('admin'), k.login('pm')]);
    [secrets, rot, audit, db] = await Promise.all([import('../../src/security/secrets.js'), import('../../src/security/rotate-keys.js'), import('../../src/security/audit.js'), import('../../src/core/db.js')]);
  });
  after(async () => {
    for (const v of ['KERNEL_SECRET_KEY', 'KERNEL_SECRET_KEYS', 'KERNEL_SECRET_KEY_ID']) delete process.env[v];
    await k?.close();
  });

  test('secrets name their key; the old v1 format still reads', async () => {
    const stored = secrets.encryptSecret('hunter2');
    assert.match(stored, /^v2:k0:/);
    assert.equal(secrets.decryptSecret(stored), 'hunter2');
    // v1: AES-GCM under sha256(KERNEL_SECRET_KEY), no key id.
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', createHash('sha256').update(K0).digest(), iv);
    const ct = Buffer.concat([c.update('legacy', 'utf8'), c.final()]);
    assert.equal(secrets.decryptSecret(`v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`), 'legacy');
  });

  test('entries from before key ids (version 2, key k0) still verify', async () => {
    const { rows } = await db.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const row = { at: new Date().toISOString(), actor_user_id: null, actor_name: 'system', actor_type: 'system', channel: '', token_prefix: '', ip: '', request_id: '', entity_type: 'settings', entity_ref: 'legacy', action: 'update', changes: {}, reason: '' };
    await db.query(
      `INSERT INTO audit_log (at, actor_name, actor_type, entity_type, entity_ref, action, prev_hash, hash, hash_version) VALUES ($1, 'system', 'system', 'settings', 'legacy', 'update', $2, $3, 2)`,
      [row.at, rows[0].hash, audit.hashOf(rows[0].hash, row, 2)],
    );
    assert.equal((await audit.verifyChain()).ok, true);
    // New entries name their key, and the key id is part of the HMAC: the same row under another id hashes differently.
    await pm.post('/api/problems', { title: 'Key id is bound' });
    const v3 = (await db.query('SELECT key_id, hash_version FROM audit_log ORDER BY id DESC LIMIT 1')).rows[0];
    assert.deepEqual([v3.hash_version, v3.key_id], [3, 'k0']);
    process.env.KERNEL_SECRET_KEYS = `kx:${K0}`;
    assert.notEqual(audit.hashOf('prev', row, 3, 'k0'), audit.hashOf('prev', row, 3, 'kx'), 'same secret, different id');
    delete process.env.KERNEL_SECRET_KEYS;
  });

  test('rotating: new data uses the new key, rotate-keys re-encrypts, and the audit trail verifies across keys', async () => {
    await admin.post('/api/webhooks', { name: 'Before rotation', url: 'https://hooks.example.com/a', events: [] });
    await pm.post('/api/problems', { title: 'Made with k0' });
    const { unsubscribeUrl, checkUnsubscribe } = await import('../../src/notifications/notifications.js');
    const oldLink = new URL(unsubscribeUrl(1, 'assigned'), 'http://kernel.test');

    process.env.KERNEL_SECRET_KEYS = `k1:${K1}`;
    process.env.KERNEL_SECRET_KEY_ID = 'k1';
    // What Kernel does at start: the switch of active key is recorded, once.
    await rot.recordActiveKey();
    await rot.recordActiveKey();
    const changed = (await db.query("SELECT changes, key_id FROM audit_log WHERE entity_type = 'keys' AND action = 'active_changed'")).rows;
    assert.equal(changed.length, 1);
    assert.deepEqual(changed[0].changes, { from: 'k0', to: 'k1' });
    assert.equal(changed[0].key_id, 'k1');
    await pm.post('/api/problems', { title: 'Made with k1' });
    const { rows: last } = await db.query('SELECT hash_version, key_id FROM audit_log ORDER BY id DESC LIMIT 1');
    assert.deepEqual([last[0].hash_version, last[0].key_id], [3, 'k1']);
    assert.equal((await audit.verifyChain()).ok, true, 'entries made with k0 and k1 both verify');

    let usage = await rot.keyUsage();
    assert.ok(usage.secrets.k0 > 0, 'the webhook secret still uses k0');
    const sec = (await admin.get('/api/admin/security')).body.checks.find((c: any) => c.id === 'key_rotation');
    assert.equal(sec.ok, false);
    assert.match(sec.detail, /rotate-keys/);

    const r = await rot.rotateSecrets();
    const reenc = (await db.query("SELECT changes FROM audit_log WHERE entity_type = 'keys' AND action = 'secrets_reencrypted' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.equal(reenc.changes.to, 'k1');
    assert.ok(Object.keys(reenc.changes.counts).length >= 1);
    assert.ok(Object.values(r.reencrypted).reduce((a, b) => a + b, 0) >= 1);
    usage = await rot.keyUsage();
    assert.deepEqual(Object.keys(usage.secrets), ['k1'], 'every secret now uses k1');
    assert.ok(usage.audit.k0 > 0 && usage.audit.k1 > 0, 'the audit trail still needs k0');
    assert.equal(checkUnsubscribe(1, 'assigned', oldLink.searchParams.get('t')!), 'email when: something is assigned to me', 'old unsubscribe links keep working');

    // Removing k0 too early: secrets are fine, but the audit entries made with it can no longer be verified.
    delete process.env.KERNEL_SECRET_KEY;
    const verify = await audit.verifyChain();
    assert.equal(verify.ok, false);
    assert.match(verify.error!, /Key k0 is needed/);
    const missing = (await admin.get('/api/admin/security')).body.checks.find((c: any) => c.id === 'key_rotation');
    assert.match(missing.detail, /k0 .* not configured/);
    process.env.KERNEL_SECRET_KEY = K0;
  });

  test('a malformed keyring stops Kernel at start', async () => {
    const { checkConfiguration } = await import('../../src/security/security.js');
    const saved = process.env.KERNEL_SECRET_KEYS;
    process.env.KERNEL_SECRET_KEYS = 'bad-pair-without-colon';
    assert.throws(() => checkConfiguration(() => {}), /id:secret/);
    process.env.KERNEL_SECRET_KEYS = 'k9:short';
    assert.throws(() => checkConfiguration(() => {}), /at least 32/);
    process.env.KERNEL_SECRET_KEYS = saved;
  });

  test('every place that encrypts a secret has its column in the rotation list', async () => {
    const dir = new URL('../../src/', import.meta.url);
    const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.ts') && !['security/secrets.ts', 'security/rotate-keys.ts'].includes(f));
    const tables = rot.SECRET_COLUMNS.map(([t]) => t);
    const expected: Record<string, string> = { 'notifications/webhooks.ts': 'webhooks', 'events/event-hooks.ts': 'event_sources', 'integrations/connectors.ts': 'connectors', 'integrations/dev.ts': 'dev_sources', 'reporting/ai.ts': 'ai_providers', 'notifications/notifications.ts': 'notification_settings', 'security/mfa.ts': 'users', 'security/sso.ts': 'settings', 'people/oncall.ts': 'paging_targets' };
    for (const f of files) {
      if (!(await readFile(new URL(f, dir), 'utf8')).includes('encryptSecret(')) continue;
      assert.ok(expected[f], `${f} encrypts a secret: add its column to SECRET_COLUMNS (and to this test)`);
      if (expected[f] !== 'settings') assert.ok(tables.includes(expected[f]), `${expected[f]} is in SECRET_COLUMNS`);
    }
  });
});
