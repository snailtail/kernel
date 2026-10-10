import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, PASSWORD, skip, startKernel, type Client, type Harness } from './harness.js';

const AWS = 'AKIAIOSFODNN7EXAMPLE';
const PW = 'S3cr3t-Hunter2';
const PNR = '19811218-9876';

/** Every place a record's text could end up: the records, their histories and the audit trail. */
async function stored(needle: string) {
  const { rows } = await ownerQuery(
    `SELECT (SELECT count(*) FROM problems p WHERE p::text LIKE $1) + (SELECT count(*) FROM problem_activity a WHERE a::text LIKE $1)
          + (SELECT count(*) FROM incidents i WHERE i::text LIKE $1) + (SELECT count(*) FROM incident_activity a WHERE a::text LIKE $1)
          + (SELECT count(*) FROM audit_log l WHERE l::text LIKE $1) + (SELECT count(*) FROM alerts x WHERE x::text LIKE $1) AS n`,
    [`%${needle}%`],
  );
  return Number(rows[0].n);
}

describe('sensitive data in records (#61)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
  });
  after(async () => k?.close());

  test('secrets are redacted before storage – never in the record, its history or the audit trail', async () => {
    const r = await pm.post('/api/problems', { title: 'Login failures', description: `Log shows key ${AWS} and db password=${PW} in the config` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.headers.get('x-kernel-redacted'), 'aws-key,password');
    assert.equal(r.body.description, 'Log shows key [REDACTED:aws-key] and db password=[REDACTED:password] in the config');
    await pm.post(`/api/problems/${r.body.ref}/comments`, { body: `Retried with Authorization: Bearer abcdef0123456789abcdef and ${AWS}` });
    await pm.patch(`/api/problems/${r.body.ref}`, { workaround: `use postgres://svc:${PW}@db/x for now` });
    assert.equal(await stored(AWS), 0);
    assert.equal(await stored(PW), 0);
    assert.equal(await stored('abcdef0123456789abcdef'), 0);
  });

  test('personal data is kept but marks the record', async () => {
    const i = await analyst.post('/api/incidents', { title: 'Caller cannot sign in', description: `Caller ${PNR} reports a lockout` });
    assert.equal(i.status, 201, JSON.stringify(i.body));
    assert.equal(i.headers.get('x-kernel-redacted'), null);
    assert.match(i.body.description, new RegExp(PNR));
    const { rows } = await ownerQuery('SELECT contains_personal_data FROM incidents WHERE ref = $1', [i.body.ref]);
    assert.equal(rows[0].contains_personal_data, true);
    const p = (await pm.post('/api/problems', { title: 'Clean' })).body;
    await pm.post(`/api/problems/${p.ref}/comments`, { body: 'Contact anna.svensson@example.com for details' });
    assert.equal((await ownerQuery('SELECT contains_personal_data FROM problems WHERE ref = $1', [p.ref])).rows[0].contains_personal_data, true);
    assert.equal((await ownerQuery("SELECT contains_personal_data FROM problems WHERE title = 'Login failures'")).rows[0].contains_personal_data, false);
  });

  test('administrators can refuse secrets instead; monitoring input is still accepted, redacted', async () => {
    assert.equal((await pm.put('/api/admin/sensitive-data', { secrets: 'block', reason: 'x' })).status, 403);
    await admin.post('/api/auth/reauth', { password: PASSWORD });
    const set = await admin.put('/api/admin/sensitive-data', { secrets: 'block', flag_personal: true, flag_ips: false, reason: 'Never store secrets, not even redacted' });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const refused = await pm.post('/api/problems', { title: 'Blocked', description: `token ${AWS}` });
    assert.equal(refused.status, 422);
    assert.deepEqual(refused.body.sensitive, ['aws-key']);
    assert.equal((await ownerQuery("SELECT count(*)::int AS n FROM problems WHERE title = 'Blocked'")).rows[0].n, 0, 'nothing was created');
    const ev = await analyst.post('/api/events', { source: 'sensitive', events: [{ host: 'app-01', check: 'login', severity: 'major', message: `auth failed for key ${AWS}` }] });
    assert.ok(ev.status < 300, JSON.stringify(ev.body));
    assert.equal(await stored(AWS), 0, 'the alert was kept, without the key');
    await admin.put('/api/admin/sensitive-data', { secrets: 'redact', flag_personal: true, flag_ips: false, reason: 'Back to redaction' });
  });

  test('the typing check reports kinds only', async () => {
    const r = await analyst.post('/api/sensitive/check', { text: `password=${PW} and ${PNR}` });
    assert.deepEqual(r.body, { secrets: ['password'], personal: ['personal-identity-number'], action: 'redact' });
    assert.equal(JSON.stringify(r.body).includes(PW), false);
  });

  test('the routes that are not scanned are a deliberate list', async () => {
    const { UNSCANNED } = await import('../../src/sensitive.js');
    const writes = k.routes.filter((r) => ['post', 'put', 'patch'].includes(r.method) && r.url.startsWith('/api/'));
    const skipped = [...new Set(writes.filter((r) => UNSCANNED.some((re) => re.test(r.url))).map((r) => r.url.replace(/\/:.*$/, '').split('/').slice(0, 4).join('/')))].sort();
    assert.deepEqual(skipped, [
      '/api/admin/ai', '/api/admin/cf-access', '/api/admin/sso', '/api/ai/analyze-log', '/api/ai/summarize',
      '/api/auth/access', '/api/auth/login', '/api/auth/logout', '/api/auth/mfa', '/api/auth/passkey', '/api/auth/passkeys',
      '/api/auth/password', '/api/auth/preferences', '/api/auth/reauth', '/api/auth/sessions', '/api/connectors', '/api/dev-hooks',
      '/api/dev-sources', '/api/event-sources', '/api/live', '/api/notifications/settings', '/api/records', '/api/sensitive/check',
      '/api/setup', '/api/setup/demo', '/api/tokens', '/api/users', '/api/webhooks',
    ], 'a route that takes secrets on purpose is added here (and to UNSCANNED) after review');
  });
});
