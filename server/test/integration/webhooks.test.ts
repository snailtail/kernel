import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('webhooks and watching', { skip }, () => {
  let k: Harness;
  let admin: Client, analyst: Client, pm: Client;
  let receiver: Server;
  let receiverUrl: string;
  const received: { headers: Record<string, any>; body: string }[] = [];
  let failNext = 0;

  before(async () => {
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

  const deliver = async () => (await import('../../src/webhooks.js')).processDeliveries();

  test('admins manage webhooks and can ping them', async () => {
    assert.equal((await pm.post('/api/webhooks', { name: 'x', url: receiverUrl })).status, 403);
    const created = await admin.post('/api/webhooks', { name: 'Receiver', url: receiverUrl, events: ['problem.created', 'problem.status_changed'] });
    assert.equal(created.status, 201);
    assert.ok(created.body.secret);
    const ping = await admin.post(`/api/webhooks/${created.body.id}/ping`);
    assert.equal(ping.body.status, 'ok');
    assert.equal(received.at(-1)!.headers['x-kernel-event'], 'ping');
  });

  test('changes are delivered, signed, filtered by event, and retried', async () => {
    const hooks = (await admin.get('/api/webhooks')).body.webhooks;
    const secret = (await admin.get(`/api/webhooks/${hooks[0].id}/secret`)).body.secret;
    received.length = 0;

    const p = (await analyst.post('/api/problems', { title: 'Webhook me' })).body;
    await analyst.post(`/api/problems/${p.ref}/comments`, { body: 'not subscribed' });
    await deliver();
    assert.equal(received.length, 1, 'only problem.created is subscribed, comments are not');
    const r = received[0];
    assert.equal(r.headers['x-kernel-event'], 'problem.created');
    assert.equal(r.headers['x-kernel-signature'], 'sha256=' + createHmac('sha256', secret).update(r.body).digest('hex'));
    const payload = JSON.parse(r.body);
    assert.equal(payload.problem.ref, p.ref);
    assert.equal(payload.actor.username, 'analyst');

    failNext = 1;
    await analyst.post(`/api/problems/${p.ref}/transition`, { to: 'analysis' });
    await deliver();
    const log = (await admin.get(`/api/webhooks/${hooks[0].id}/deliveries`)).body;
    assert.equal(log[0].status, 'pending');
    assert.equal(log[0].attempts, 1);
    assert.match(log[0].last_error, /503/);
  });

  test('slack format', async () => {
    const { formatBody } = await import('../../src/webhooks.js');
    const body = formatBody('slack', { event: 'problem.created', summary: 'Logged', actor: { display_name: 'Ann' }, problem: { ref: 'PRB1', title: 'T', url: null } });
    assert.deepEqual(body, { text: '*PRB1: T*\nAnn: Logged' });
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
