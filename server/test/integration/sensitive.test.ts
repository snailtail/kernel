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

/** Setup calls must succeed: a refused setup would make a test of absence pass for the wrong reason. */
const ok = (r: { status: number; body: unknown }) => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);

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
    ok(await pm.post(`/api/problems/${r.body.ref}/comments`, { body: `Retried with Authorization: Bearer abcdef0123456789abcdef and ${AWS}` }));
    ok(await pm.patch(`/api/problems/${r.body.ref}`, { workaround: `use postgres://svc:${PW}@db/x for now` }));
    // Positive control: the same query finds what was stored (the redaction markers and the rest of the text).
    assert.ok((await stored('[REDACTED:aws-key]')) >= 2, 'the record and the comment were searched (the audit trail keeps free text only as a digest)');
    assert.ok((await stored('postgres://svc:[REDACTED:url-password]@db/x')) >= 1);
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
    ok(await pm.post(`/api/problems/${p.ref}/comments`, { body: 'Contact anna.svensson@example.com for details' }));
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
    assert.ok((await stored('auth failed for key [REDACTED:aws-key]')) >= 1, 'the alert was kept');
    assert.equal(await stored(AWS), 0, 'without the key');
    await admin.put('/api/admin/sensitive-data', { secrets: 'redact', flag_personal: true, flag_ips: false, reason: 'Back to redaction' });
  });

  test('a body cannot reach an object\'s prototype through the scan', async () => {
    const raw = '{"title":"Proto","description":"x","__proto__":{"description":"AKIAIOSFODNN7EXAMPLE"}}';
    const r = await fetch(`${k.base}/api/problems`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: pm.cookie!, 'X-Kernel-Request': '1' }, body: raw });
    assert.equal(r.status, 400, 'the JSON parser refuses __proto__ before any handler or the scan sees it');
    assert.equal(({} as any).description, undefined);
  });

  test('managers remove old secrets and named text from a record and its history, with step-up and a reason', async () => {
    const OLD = 'AKIAZZZZZZZZZZZZZZZZ';
    const NAME = 'Anna Svensson-Lind';
    const p = (await pm.post('/api/problems', { title: 'Older problem' })).body;
    ok(await pm.post(`/api/problems/${p.ref}/comments`, { body: 'first look' }));
    // Text from before the scanner existed: written straight to the database.
    await ownerQuery(`UPDATE problems SET description = $2 WHERE ref = $1`, [p.ref, `key ${OLD}, reported by ${NAME}`]);
    await ownerQuery(`UPDATE problem_activity SET body = $2, data = $3 WHERE problem_id = (SELECT id FROM problems WHERE ref = $1) AND kind = 'comment'`, [p.ref, `call ${NAME}, key ${OLD}`, JSON.stringify({ to: `old key ${OLD}` })]);
    const up = await fetch(`${k.base}/api/records/${p.ref}/attachments?filename=old.log`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: pm.cookie!, 'X-Kernel-Request': '1' }, body: new TextEncoder().encode(`user ${NAME} logged in`) });
    assert.ok(up.ok);
    // Copies Kernel keeps: an in-app notification (already emailed) and a queued webhook payload.
    const uid = (await ownerQuery("SELECT id FROM users WHERE username = 'analyst'")).rows[0].id;
    const note = await ownerQuery("INSERT INTO notifications (user_id, event, ref, title, summary, url, dedupe_key) VALUES ($1, 'comment', $2, $3, $4, '/', 'redact-test') RETURNING id", [uid, p.ref, `Comment on ${p.ref}`, `${NAME} wrote a comment`]);
    await ownerQuery("INSERT INTO notification_deliveries (notification_id, user_id, channel, status, sent_at) VALUES ($1, $2, 'email', 'sent', now())", [note.rows[0].id, uid]);
    const hook = await ownerQuery("INSERT INTO webhooks (name, url, format, events, active, secret) VALUES ('copy', 'https://hooks.example.com/c', 'json', '{}', true, 'x') RETURNING id");
    await ownerQuery("INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1, 'problem.updated', $2)", [hook.rows[0].id, JSON.stringify({ problem: { ref: p.ref }, summary: `${NAME} commented` })]);
    const png = await (await import('sharp')).default({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const img = await fetch(`${k.base}/api/records/${p.ref}/attachments?filename=screen.png`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: pm.cookie!, 'X-Kernel-Request': '1' }, body: png });
    assert.ok(img.ok, `image upload: ${img.status} ${await img.text()}`);
    // Positive control: the old text is there before.
    assert.ok((await stored(OLD)) >= 2);
    assert.ok((await stored(NAME)) >= 2);

    assert.equal((await analyst.post(`/api/records/${p.ref}/redact`, { secrets: true, reason: 'Old key' })).status, 403, 'managers and administrators only');
    // A session signed in long ago must confirm it is the user first.
    await ownerQuery("UPDATE sessions SET reauth_at = now() - interval '1 hour' WHERE user_id = (SELECT id FROM users WHERE username = 'pm')");
    assert.equal((await pm.post(`/api/records/${p.ref}/redact`, { secrets: true, reason: 'x' })).status, 403, 'step-up first');
    await pm.post('/api/auth/reauth', { password: PASSWORD });
    assert.equal((await pm.post(`/api/records/${p.ref}/redact`, { secrets: true })).status, 400, 'a reason is required');
    assert.equal((await pm.post(`/api/records/${p.ref}/redact`, { text: 'not', reason: 'x' })).status, 400, 'a short text cannot rewrite history');
    // The preview counts with the same statements and changes nothing.
    const preview = await pm.post(`/api/records/${p.ref}/redact`, { secrets: true, text: NAME, dry_run: true });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.dry_run, true);
    assert.ok(preview.body.places.problems >= 2 && preview.body.places.problem_activity >= 2 && preview.body.places.attachments >= 1, JSON.stringify(preview.body.places));
    assert.equal(preview.body.places.notifications, 1);
    assert.equal(preview.body.places.webhook_deliveries, 1);
    assert.deepEqual(preview.body.outside.sent, { email: 1 }, 'the dialog says what was already emailed');
    assert.deepEqual(preview.body.outside.images, ['screen.png'], 'and which screenshots were not scanned');
    assert.ok((await stored(OLD)) >= 2, 'nothing changed');
    const r = await pm.post(`/api/records/${p.ref}/redact`, { secrets: true, text: NAME, reason: 'Key and caller name written before redaction existed' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.removed >= 4, JSON.stringify(r.body));
    assert.equal(await stored(OLD), 0);
    assert.equal(await stored(NAME), 0);
    assert.equal((await ownerQuery('SELECT count(*)::int AS n FROM notifications WHERE summary LIKE $1', [`%${NAME}%`])).rows[0].n, 0);
    assert.equal((await ownerQuery('SELECT count(*)::int AS n FROM webhook_deliveries WHERE payload::text LIKE $1', [`%${NAME}%`])).rows[0].n, 0);
    const blob = await ownerQuery("SELECT convert_from(data, 'UTF8') AS t FROM attachment_blobs b JOIN attachments a ON a.id = b.attachment_id WHERE a.record_ref = $1 AND a.kind = 'text'", [p.ref]);
    assert.equal(blob.rows[0].t, 'user [REDACTED] logged in');
    // The fact of the change stays, and the removal is recorded – without the text.
    const record = (await pm.get(`/api/problems/${p.ref}`)).body;
    assert.match(record.description, /^key \[REDACTED:aws-key\], reported by \[REDACTED\]$/);
    assert.ok(record.activity.some((a: any) => a.body?.startsWith('Removed sensitive text')));
    const trail = await ownerQuery("SELECT changes::text AS c FROM audit_log WHERE action = 'redact_history'");
    assert.equal(trail.rows.length, 1);
    assert.ok(!trail.rows[0].c.includes(NAME));
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
      '/api/admin/ai', '/api/admin/cf-access', '/api/admin/sso', '/api/ai/analyze-log', '/api/ai/review-wording', '/api/ai/summarize',
      '/api/auth/access', '/api/auth/login', '/api/auth/logout', '/api/auth/mfa', '/api/auth/passkey', '/api/auth/passkeys',
      '/api/auth/password', '/api/auth/preferences', '/api/auth/reauth', '/api/auth/sessions', '/api/connectors', '/api/dev-hooks',
      '/api/dev-sources', '/api/event-sources', '/api/live', '/api/notifications/settings',
      // The portal's sign-in (#45): its body is the sign-in token itself, or an email address.
      '/api/portal/auth', '/api/records', '/api/sensitive/check',
      '/api/setup', '/api/setup/demo', '/api/tokens', '/api/users', '/api/webhooks',
    ], 'a route that takes secrets on purpose is added here (and to UNSCANNED) after review');
  });
});
