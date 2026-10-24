import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { Client, ownerQuery, skip, startKernel, type Harness } from './harness.js';

describe('webhooks and watching', { skip }, () => {
  let k: Harness;
  let admin: Client, analyst: Client, pm: Client;
  let receiver: Server;
  let receiverUrl: string;
  const received: { headers: Record<string, any>; body: string }[] = [];
  let failNext = 0;

  let secret: string;
  let hookId: number;

  before(async () => {
    process.env.KERNEL_SECRET_KEY = 'test-secret-key-0123456789abcdefghijklmnop';
    process.env.KERNEL_OUTBOUND_ALLOW = '127.0.0.1';
    k = await startKernel();
    [admin, analyst, pm] = await Promise.all([k.login('admin'), k.login('analyst'), k.login('pm')]);
    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (failNext > 0) {
          failNext--;
          res.writeHead(503).end();
          return;
        }
        received.push({ headers: req.headers, body });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  });
  after(async () => {
    receiver?.close();
    await k?.close();
  });

  const deliver = async () => (await import('../../src/notifications/webhooks.js')).processDeliveries();

  test('admins manage webhooks; secrets are shown once and encrypted at rest', async () => {
    assert.equal((await pm.post('/api/webhooks', { name: 'x', url: receiverUrl })).status, 403);
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:8080/', 'http://10.0.0.5/hook', 'ftp://x.example']) {
      assert.equal((await admin.post('/api/webhooks', { name: 'bad', url })).status, 400, url);
    }
    const created = await admin.post('/api/webhooks', { name: 'Receiver', url: receiverUrl, events: ['problem.created', 'problem.status_changed', 'problem.updated'] });
    assert.equal(created.status, 201);
    assert.match(created.body.secret, /^whsec_/);
    secret = created.body.secret;
    hookId = created.body.id;
    assert.equal((await admin.get('/api/webhooks')).body.webhooks[0].secret, undefined, 'never listed');
    const { pool } = await import('../../src/core/db.js');
    const stored = (await pool.query('SELECT secret FROM webhooks WHERE id = $1', [hookId])).rows[0].secret;
    assert.match(stored, /^v2:k0:/);
    assert.ok(!stored.includes(secret.slice(6, 20)));
  });

  test('ping sends only its own delivery', async () => {
    const { pool } = await import('../../src/core/db.js');
    await pool.query(`INSERT INTO webhook_deliveries (webhook_id, event, payload, next_attempt_at) VALUES ($1, 'problem.updated', '{}', now() + interval '1 hour')`, [hookId]);
    const queuedNow = await pool.query(`INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1, 'problem.updated', '{}') RETURNING id`, [hookId]);
    const ping = await admin.post(`/api/webhooks/${hookId}/ping`);
    assert.equal(ping.body.status, 'ok');
    assert.equal(received.at(-1)!.headers['x-kernel-event'], 'ping');
    const other = (await pool.query('SELECT status FROM webhook_deliveries WHERE id = $1', [queuedNow.rows[0].id])).rows[0];
    assert.equal(other.status, 'pending', 'other due deliveries are left to the worker');
    await pool.query("DELETE FROM webhook_deliveries WHERE event = 'problem.updated'");
  });

  test('deleting a webhook takes its reason from the body, never from the query string', async () => {
    const hook = (await admin.post('/api/webhooks', { name: 'Short-lived', url: 'https://hooks.example.com/gone', events: [] })).body;
    const { pool } = await import('../../src/core/db.js');
    const audited = async () => (await ownerQuery("SELECT reason FROM audit_log WHERE entity_type = 'webhook' AND entity_ref = $1 AND action = 'delete'", [String(hook.id)])).rows;
    // The old DELETE shape, with the reason in the query string, is gone: nothing stored.
    const old = await admin.del(`/api/webhooks/${hook.id}?reason=${encodeURIComponent('Query reason about Bob')}`);
    assert.equal(old.status, 404);
    assert.deepEqual(await audited(), []);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM webhooks WHERE id = $1', [hook.id])).rows[0].n, 1, 'not deleted');
    assert.equal((await admin.post(`/api/webhooks/${hook.id}/delete`, {})).status, 400, 'a reason is required');
    assert.equal((await pm.post(`/api/webhooks/${hook.id}/delete`, { reason: 'x' })).status, 403);
    assert.equal((await admin.post(`/api/webhooks/${hook.id}/delete`, { reason: 'Receiver retired' })).status, 200);
    assert.deepEqual((await audited()).map((r) => r.reason), ['Receiver retired']);
    assert.equal((await ownerQuery("SELECT count(*)::int AS n FROM audit_log WHERE reason LIKE '%Bob%'")).rows[0].n, 0);
  });

  test('changes are delivered with Standard Webhooks signatures, minimal data, filtered by event, and retried', async () => {
    received.length = 0;

    const p = (await analyst.post('/api/problems', { title: 'Webhook me' })).body;
    await analyst.post(`/api/problems/${p.ref}/comments`, { body: 'not subscribed' });
    await deliver();
    assert.equal(received.length, 1, 'only problem.created is subscribed, comments are not');
    const r = received[0];
    assert.equal(r.headers['x-kernel-event'], 'problem.created');
    assert.equal(r.headers['x-kernel-signature'], 'sha256=' + createHmac('sha256', secret).update(r.body).digest('hex'));
    const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${r.headers['webhook-id']}.${r.headers['webhook-timestamp']}.${r.body}`).digest('base64');
    assert.equal(r.headers['webhook-signature'], `v1,${expected}`);
    assert.ok(Math.abs(Number(r.headers['webhook-timestamp']) - Date.now() / 1000) < 60);
    const payload = JSON.parse(r.body);
    assert.equal(payload.problem.ref, p.ref);
    assert.equal(payload.actor.username, 'analyst');

    received.length = 0;
    await analyst.patch(`/api/problems/${p.ref}`, { description: 'Secret detail '.repeat(30), impact: 1 });
    await deliver();
    const update = JSON.parse(received[0].body);
    assert.deepEqual(update.data.impact, { from: 3, to: 1 });
    assert.deepEqual(update.data.description, { changed: true }, 'long texts never leave Kernel in webhooks');
    assert.ok(!received[0].body.includes('Secret detail'));
    received.length = 0;

    failNext = 1;
    await analyst.post(`/api/problems/${p.ref}/transition`, { to: 'analysis' });
    await deliver();
    const log = (await admin.get(`/api/webhooks/${hookId}/deliveries`)).body;
    assert.equal(log[0].status, 'pending');
    assert.equal(log[0].attempts, 1);
    assert.match(log[0].last_error, /503/);
  });

  test('slack and Teams Workflows formats', async () => {
    const { formatBody } = await import('../../src/notifications/webhooks.js');
    const payload = { event: 'problem.created', summary: 'Logged', actor: { display_name: 'Ann' }, problem: { ref: 'PRB1', title: 'T', url: 'https://k.example/problems/PRB1' } };
    assert.deepEqual(formatBody('slack', { ...payload, problem: { ...payload.problem, url: null } }), { text: '*PRB1: T*\nAnn: Logged' });
    const teams: any = formatBody('teams_workflow', payload);
    assert.equal(teams.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
    assert.equal(teams.attachments[0].content.actions[0].url, payload.problem.url);
  });

  test('rotating the secret returns a new one once', async () => {
    const rotated = await admin.post(`/api/webhooks/${hookId}/rotate`);
    assert.match(rotated.body.secret, /^whsec_/);
    assert.notEqual(rotated.body.secret, secret);
  });

  test('creators and assignees watch problems, and see others changes', async () => {
    const me = (await analyst.get('/api/auth/me')).body;
    const p = (await pm.post('/api/problems', { title: 'Watch me', assignee_id: me.id })).body;
    assert.deepEqual(p.watchers.map((w: any) => w.display_name).sort(), ['Analyst', 'Pm']);
    await pm.post(`/api/problems/${p.ref}/comments`, { body: 'Update from pm' });
    const dash = (await analyst.get('/api/dashboard')).body;
    assert.ok(dash.watched_activity.some((a: any) => a.ref === p.ref && a.kind === 'comment'));
    const unwatched = await analyst.del(`/api/problems/${p.ref}/watch`);
    assert.deepEqual(unwatched.body.watchers.map((w: any) => w.display_name), ['Pm']);
  });
});
