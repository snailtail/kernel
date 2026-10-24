import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

const MARKER = `INTERNAL-${randomBytes(4).toString('hex')}`;

describe('service status page (#46)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;
  let svc: string, vm: string, inc: string;

  let subs: typeof import('../../src/status/status-subscriptions.js');
  let notifications: typeof import('../../src/notifications/notifications.js');
  const anon = (path: string, init?: RequestInit) => fetch(`${k.base}${path}`, init);
  const form = (path: string, fields: [string, string][]) =>
    anon(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' }, body: new URLSearchParams(fields).toString() });
  const mailTo = (to: string) => notifications.capturedMail.filter((m) => m.to === to);
  const link = (text: string, path: string) => text.match(new RegExp(`https?://[^\\s]*${path}[^\\s]*`))![0].replace(/^https?:\/\/[^/]+/, '');

  before(async () => {
    process.env.KERNEL_SECRET_KEY = 'status-test-key-0123456789abcdefghijklmn';
    process.env.SMTP_URL = 'capture:';
    process.env.KERNEL_PUBLIC_URL = 'https://kernel.example.com';
    k = await startKernel();
    subs = await import('../../src/status/status-subscriptions.js');
    notifications = await import('../../src/notifications/notifications.js');
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
    // Internal names, hosts and incident texts all carry the marker; none of it may reach the public page.
    svc = (await pm.post('/api/cis', { name: `Webshop ${MARKER}`, ci_type: 'business_service' })).body.ref;
    vm = (await pm.post('/api/cis', { name: `shop-vm01.${MARKER}.internal`, ci_type: 'virtual_machine' })).body.ref;
    await pm.post(`/api/cis/${vm}/relationships`, { type: 'member_of', target: svc });
    inc = (await analyst.post('/api/incidents', { title: `Checkout down ${MARKER}`, impact: 1, urgency: 1, cis: [vm] })).body.ref;
  });
  after(async () => {
    delete process.env.KERNEL_SECRET_KEY;
    delete process.env.SMTP_URL;
    delete process.env.KERNEL_PUBLIC_URL;
    await k?.close();
  });

  test('Kernel suggests a status from incidents on the service and its components; a person sets it', async () => {
    const board = (await analyst.get('/api/status')).body;
    const s = board.services.find((x: any) => x.ref === svc);
    assert.equal(s.suggested, 'major_outage', 'a P1 incident on a component of the service');
    assert.deepEqual(s.incidents.map((i: any) => i.ref), [inc]);
    assert.equal(s.status, 'operational', 'nothing changes until a person sets it');
    assert.equal((await analyst.put(`/api/status/${svc}`, { status: 'major_outage' })).status, 200);
    assert.equal((await analyst.put(`/api/status/${svc}`, { status: 'major_outage', publish: true })).status, 403, 'publishing is for managers');
  });

  test('the public page is off by default and shows only what people published, under curated names', async () => {
    const anon = (path: string) => fetch(`${k.base}${path}`);
    assert.equal((await anon('/api/public/status')).status, 404);
    assert.equal((await anon('/status')).status, 404);
    assert.equal((await pm.put(`/api/status/${svc}/public`, { public: true })).status, 400, 'a public name is required');
    await pm.put(`/api/status/${svc}/public`, { public: true, public_name: 'Online shop', public_description: 'Ordering and payment' });
    await pm.put('/api/admin/status-page', { public_enabled: true, title: 'Acme status', reason: 'Customers ask during outages' });
    await analyst.post('/api/status/updates', { incident: inc, services: [svc], phase: 'investigating', status: 'major_outage', message: `Internal: db pool exhausted on ${MARKER}` });
    let page = await anon('/api/public/status').then((r) => r.json() as any);
    assert.deepEqual(page.services, [{ name: 'Online shop', description: 'Ordering and payment', status: 'operational' }], 'internal updates change nothing publicly');
    assert.equal((await analyst.post('/api/status/updates', { services: [svc], phase: 'identified', message: 'Ordering is unavailable.', public: true })).status, 403);
    await pm.post('/api/status/updates', { incident: inc, services: [svc], phase: 'identified', status: 'major_outage', message: 'Ordering is unavailable. We are working on it.', public: true });
    const res = await anon('/api/public/status');
    page = await res.json();
    assert.equal(page.services[0].status, 'major_outage');
    assert.equal(page.updates[0].message, 'Ordering is unavailable. We are working on it.');
    assert.match(res.headers.get('cache-control')!, /public, max-age=30/);
    const etag = res.headers.get('etag')!;
    assert.equal((await fetch(`${k.base}/api/public/status`, { headers: { 'If-None-Match': etag } })).status, 304);
    const html = await anon('/status');
    const text = await html.text();
    assert.match(html.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.ok(!/<script/i.test(text));
    for (const body of [JSON.stringify(page), text]) {
      assert.ok(!body.includes(MARKER), 'no CI names, hosts, incident texts or internal updates');
      assert.ok(!body.includes(inc), 'no incident refs');
    }
    assert.equal((await fetch(`${k.base}/api/public/status`, { method: 'POST' })).status, 404, 'GET only');
  });

  test('a published update can be retracted, with a reason in the body, and it leaves the page', async () => {
    const board = (await pm.get('/api/status')).body;
    const published = board.updates.find((u: any) => u.public);
    assert.equal((await pm.post(`/api/status/updates/${published.id}/retract`, {})).status, 400, 'a reason is required');
    // The old DELETE shape, with the reason in the query string, is gone: nothing stored.
    const old = await pm.del(`/api/status/updates/${published.id}?reason=${encodeURIComponent('Query reason about Bob')}`);
    assert.equal(old.status, 404);
    assert.equal((await ownerQuery("SELECT count(*)::int AS n FROM audit_log WHERE action = 'retract'")).rows[0].n, 0);
    assert.equal((await pm.post(`/api/status/updates/${published.id}/retract`, { reason: 'Wrong service' })).status, 200);
    const page = await fetch(`${k.base}/api/public/status`).then((r) => r.json() as any);
    assert.equal(page.updates.length, 0);
    const history = (await analyst.get(`/api/incidents/${inc}`)).body.activity;
    assert.ok(history.some((a: any) => a.kind === 'communication' && /Public status update/.test(a.body)), 'the incident keeps its communication log');
    void admin;
  });

  test('staff follow a service and hear about its updates by their own channels', async () => {
    assert.equal((await analyst.put(`/api/status/${svc}/follow`, { follow: true })).status, 200);
    assert.equal((await analyst.get('/api/status')).body.services.find((x: any) => x.ref === svc).following, true);
    await pm.post('/api/status/updates', { services: [svc], phase: 'monitoring', message: 'Watching the database pool.' });
    const mine = (await analyst.get('/api/notifications')).body.notifications;
    assert.ok(mine.some((n: any) => n.event === 'service_status' && /Watching the database pool/.test(n.summary) && n.url === '/service-status'));
    // An internal update goes to nobody outside.
    assert.equal((await ownerQuery('SELECT count(*)::int AS n FROM status_deliveries')).rows[0].n, 0);
    await analyst.put(`/api/status/${svc}/follow`, { follow: false });
  });

  let subscriber = 0;
  let major = '';
  test('people outside sign up for public services with double opt-in, and the answer never tells who is subscribed', async () => {
    const page = await anon('/status').then((r) => r.text());
    assert.match(page, /<form method="post" action="\/status\/subscribe">/);
    const first = await form('/status/subscribe', [['email', 'Customer@Example.com'], ['service', 'Online shop']]);
    assert.equal(first.status, 200);
    assert.match(first.headers.get('content-security-policy')!, /form-action 'self'/);
    await ownerQuery("UPDATE status_subscribers SET created_at = now() - interval '8 days' WHERE email = 'customer@example.com'");
    const again = await form('/status/subscribe', [['email', 'customer@example.com'], ['service', 'Online shop']]);
    assert.ok((await ownerQuery("SELECT created_at > now() - interval '1 minute' AS fresh FROM status_subscribers WHERE email = 'customer@example.com'")).rows[0].fresh, 'an unconfirmed sign-up gets its week from the latest request');
    const stranger = await anon('/status/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nobody@example.com' }) });
    assert.equal((await first.text()), await again.text(), 'the same answer for a repeated address');
    assert.equal((await stranger.json() as any).message, subs.SIGNED_UP);
    assert.equal((await form('/status/subscribe', [['email', 'not an address']])).status, 400);
    assert.equal((await form('/status/subscribe', [['email', 'a@example.com'], ['service', `Webshop ${MARKER}`]])).status, 400, 'internal names are not services on the page');

    await subs.processStatusDeliveries(50);
    const mails = mailTo('customer@example.com');
    assert.equal(mails.length, 1, 'one confirmation in flight per address');
    assert.match(mails[0].subject, /Confirm your subscription to Acme status/);
    assert.match(mails[0].headers['List-Unsubscribe'], /\/status\/unsubscribe\?s=\d+&token=/);
    const confirmPath = link(mails[0].text, '/status/confirm');
    subscriber = Number(new URL(confirmPath, k.base).searchParams.get('s'));
    // Opening the link (as a mail scanner does) changes nothing.
    const shown = await anon(confirmPath);
    assert.match(await shown.text(), /Receive updates on Online shop by email\?/);
    assert.equal((await ownerQuery('SELECT confirmed_at FROM status_subscribers WHERE id = $1', [subscriber])).rows[0].confirmed_at, null);
    assert.equal((await anon(confirmPath, { method: 'POST', headers: { Accept: 'text/html' } })).status, 200);
    assert.ok((await ownerQuery('SELECT confirmed_at FROM status_subscribers WHERE id = $1', [subscriber])).rows[0].confirmed_at);
    assert.equal((await anon(confirmPath, { method: 'POST' })).status, 400, 'the link works once');
    const tokenRow = (await ownerQuery('SELECT confirm_hash FROM status_subscribers WHERE id = $1', [subscriber])).rows[0];
    assert.equal(tokenRow.confirm_hash, null);
  });

  test('a published update reaches subscribers and organisation contacts with the published text only', async () => {
    const org = (await pm.post('/api/organisations', { name: 'Customer Ltd', kind: 'customer', services: [svc] })).body.id;
    const contact = (await pm.post('/api/people', { name: 'Carla Contact', email: 'carla@customer.example', organisation_id: org, status_contact: true })).body.id;
    assert.equal((await analyst.post('/api/people', { name: 'Not allowed', status_contact: true })).status, 403, 'contacts are chosen by managers');
    await pm.post('/api/people', { name: 'Quiet Colleague', email: 'quiet@customer.example', organisation_id: org });
    major = (await analyst.post('/api/incidents', { title: `Payments down ${MARKER}`, impact: 1, urgency: 1, cis: [vm] })).body.ref;
    assert.equal((await pm.post(`/api/incidents/${major}/major`, {})).status, 200);
    const proposal = (await pm.get(`/api/incidents/${major}`)).body.status_proposal;
    assert.match(proposal.message, /affecting Online shop\./, 'the proposal names services as people outside know them');
    assert.ok(!proposal.message.includes(MARKER));

    await pm.post('/api/status/updates', { incident: major, services: [svc], phase: 'identified', status: 'partial_outage', message: 'Payments fail for some customers.', public: true });
    await subs.processStatusDeliveries(50);
    const sent = [...mailTo('customer@example.com').slice(1), ...mailTo('carla@customer.example')];
    assert.equal(sent.length, 2);
    for (const m of sent) {
      assert.match(m.subject, /^\[Acme status\] Identified: Online shop$/);
      assert.match(m.text, /Payments fail for some customers\./);
      assert.match(m.text, /Status: Partial outage/);
      assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
      for (const secret of [MARKER, major, 'Pm', 'Webshop']) assert.ok(!(m.subject + m.text).includes(secret), `no ${secret} in mail to people outside`);
    }
    assert.match(mailTo('carla@customer.example')[0].text, /as the contact for Customer Ltd\./);
    assert.equal(mailTo('quiet@customer.example').length, 0, 'only people marked as contacts');

    // The communication log on the major incident: who, which organisation, when, which text.
    const log = (await pm.get(`/api/incidents/${major}`)).body.major.communications;
    assert.equal(log.length, 1);
    assert.equal(log[0].message, 'Payments fail for some customers.');
    assert.deepEqual(log[0].contacts.map((c: any) => [c.person_id, c.name, c.status]), [[contact, 'Carla Contact', 'sent']]);
    assert.ok(log[0].contacts[0].sent_at);
    assert.equal(log[0].subscribers_sent, 1);
  });

  test('a status webhook carries only published text, and only when chosen', async () => {
    const hook = (await admin.post('/api/webhooks', { name: 'Status', url: 'https://hooks.example.com/status', events: ['status.published'], services: [svc] })).body;
    assert.deepEqual(hook.services, [svc]);
    await admin.post('/api/webhooks', { name: 'Everything', url: 'https://hooks.example.com/all', events: [] });
    await pm.post('/api/status/updates', { incident: inc, services: [svc], phase: 'monitoring', message: 'A fix is rolling out.', public: true });
    const { rows } = await ownerQuery("SELECT w.name, d.payload FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.event = 'status.published'");
    assert.deepEqual(rows.map((r: any) => r.name), ['Status'], '"all events" means the problem events');
    assert.deepEqual(rows[0].payload.status_update.services, ['Online shop']);
    assert.equal(rows[0].payload.status_update.message, 'A fix is rolling out.');
    assert.ok(!JSON.stringify(rows[0].payload).includes(MARKER) && !JSON.stringify(rows[0].payload).includes(inc));
    assert.equal((await pm.post('/api/webhooks', { name: 'Mine', url: 'https://hooks.example.com/x', events: ['status.published'] })).status, 403, 'administrators only');
    await subs.processStatusDeliveries(50);
  });

  test('retracting stops mail that has not gone yet', async () => {
    await pm.post('/api/status/updates', { services: [svc], phase: 'resolved', status: 'operational', message: 'Wrong text, retract me.', public: true });
    const id = (await pm.get('/api/status')).body.updates[0].id;
    assert.equal((await pm.post(`/api/status/updates/${id}/retract`, { reason: 'Posted too early' })).status, 200);
    const before = notifications.capturedMail.length;
    await subs.processStatusDeliveries(50);
    assert.equal(notifications.capturedMail.length, before);
    assert.deepEqual((await ownerQuery('SELECT DISTINCT status FROM status_deliveries WHERE update_id = $1', [id])).rows.map((r: any) => r.status), ['skipped']);
    const hooks = await ownerQuery("SELECT status, last_error FROM webhook_deliveries WHERE event = 'status.published' AND payload->'data'->>'status_update_id' = $1", [String(id)]);
    assert.deepEqual(hooks.rows, [{ status: 'failed', last_error: 'Retracted' }], 'the status webhook does not carry it either');
  });

  test('unsubscribing: GET only asks, the one-click POST removes the subscriber, a forged link does nothing', async () => {
    const unsub = link(mailTo('customer@example.com').at(-1)!.text, '/status/unsubscribe');
    assert.match(await anon(unsub).then((r) => r.text()), /Stop email about service status\?/);
    assert.equal((await ownerQuery('SELECT count(*)::int AS n FROM status_subscribers WHERE id = $1', [subscriber])).rows[0].n, 1);
    assert.equal((await anon(`/status/unsubscribe?s=${subscriber}&token=forged`, { method: 'POST' })).status, 400);
    assert.equal((await anon(unsub.replace(`s=${subscriber}`, `s=${subscriber + 1}`), { method: 'POST' })).status, 400, 'a link is bound to one subscriber');
    const r = await anon(unsub, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(r.status, 200);
    assert.equal((await ownerQuery('SELECT count(*)::int AS n FROM status_subscribers WHERE id = $1', [subscriber])).rows[0].n, 0, 'the address is gone');
    assert.equal((await pm.get(`/api/incidents/${major}`)).body.major.communications[0].subscribers_sent, 1, 'the communication log keeps what was sent');
    const contactLink = link(mailTo('carla@customer.example')[0].text, '/status/unsubscribe');
    assert.equal((await anon(contactLink, { method: 'POST' })).status, 200);
    assert.equal((await ownerQuery("SELECT status_contact FROM people WHERE email = 'carla@customer.example'")).rows[0].status_contact, false);
  });

  test('sign-up is limited per address (quietly) and per client', async () => {
    const pending = async () => (await ownerQuery("SELECT count(*)::int AS n FROM status_deliveries d JOIN status_subscribers s ON s.id = d.subscriber_id WHERE d.kind = 'confirm' AND s.email = 'flood@example.com'")).rows[0].n;
    for (let n = 0; n < 3; n++) {
      await anon('/status/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'flood@example.com' }) });
      await subs.processStatusDeliveries(50);
    }
    assert.equal(await pending(), 3);
    const quiet = await anon('/status/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'flood@example.com' }) });
    assert.equal((await quiet.json() as any).message, subs.SIGNED_UP, 'the same answer');
    assert.equal(await pending(), 3, 'but nothing more is sent');
    let limited = 0;
    for (let n = 0; n < 12; n++) {
      const r = await anon('/status/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `x${n}@example.com` }) });
      if (r.status === 429) limited++;
    }
    assert.ok(limited > 0, 'a client is limited');
  });

  test('without the public page there is nothing to sign up for', async () => {
    await pm.put('/api/admin/status-page', { public_enabled: false, title: 'Acme status', reason: 'Closing it' });
    assert.equal((await anon('/status/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'late@example.com' }) })).status, 404);
  });
});
