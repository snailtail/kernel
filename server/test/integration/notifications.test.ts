import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('notifications (#48)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;
  let n: typeof import('../../src/notifications.js');
  let sla: typeof import('../../src/sla.js');
  let db: typeof import('../../src/db.js');
  const ids: Record<string, number> = {};
  const mailTo = (who: string) => n.capturedMail.filter((m) => m.to === `${who}@example.com`);
  const deliver = async () => {
    await n.processNotificationDeliveries(100);
  };

  before(async () => {
    process.env.KERNEL_SECRET_KEY = 'notify-test-key-0123456789abcdefghijklmn';
    process.env.SMTP_URL = 'capture:';
    k = await startKernel();
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
    n = await import('../../src/notifications.js');
    sla = await import('../../src/sla.js');
    db = await import('../../src/db.js');
    for (const u of (await admin.get('/api/users')).body) {
      ids[u.username] = u.id;
      await db.query('UPDATE users SET email = $2 WHERE id = $1', [u.id, `${u.username}@example.com`]);
    }
  });
  after(async () => {
    delete process.env.KERNEL_SECRET_KEY;
    delete process.env.SMTP_URL;
    await k?.close();
  });

  test('an assignment reaches the assignee in the app and by email, never the actor', async () => {
    const i = (await analyst.post('/api/incidents', { title: 'Scanner broken', assignee_id: ids.pm })).body;
    const mine = (await pm.get('/api/notifications')).body;
    assert.equal(mine.unread, 1);
    assert.deepEqual([mine.notifications[0].event, mine.notifications[0].ref, mine.notifications[0].url], ['assigned', i.ref, `/incidents/${i.ref}`]);
    assert.equal((await analyst.get('/api/notifications')).body.unread, 0, 'the actor is not notified');
    await analyst.post('/api/incidents', { title: 'Mine', assignee_id: ids.analyst });
    assert.equal((await analyst.get('/api/notifications')).body.unread, 0, 'not even when assigning to yourself');
    await deliver();
    const mail = mailTo('pm').at(-1)!;
    assert.match(mail.subject, new RegExp(`\\[Kernel\\] ${i.ref}: Scanner broken`));
    assert.match(mail.text, /Unsubscribe: .*\/api\/notifications\/unsubscribe\?u=\d+&e=assigned&t=/);
    assert.match(mail.headers['List-Unsubscribe'], /unsubscribe/);
    assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    const read = (await pm.post('/api/notifications/read', { all: true })).body;
    assert.equal(read.unread, 0);
  });

  test('watchers hear about notes in the app only; SLA breaches notify once', async () => {
    const p = (await analyst.post('/api/problems', { title: 'Scanner keeps failing' })).body;
    await pm.put(`/api/problems/${p.ref}/watch`, {});
    const before = mailTo('pm').length;
    await analyst.post(`/api/problems/${p.ref}/comments`, { body: 'Firmware 2.1 suspected' });
    await deliver();
    assert.ok((await pm.get('/api/notifications?unread=true')).body.notifications.some((x: any) => x.event === 'watched_update' && x.ref === p.ref));
    assert.equal(mailTo('pm').length, before, 'watched updates do not email by default');
    const i = (await analyst.post('/api/incidents', { title: 'Payments failing', impact: 1, urgency: 1, assignee_id: ids.pm })).body;
    await db.query("UPDATE incidents SET created_at = created_at - interval '300 minutes' WHERE ref = $1", [i.ref]);
    await sla.recomputeSla(db.pool, (await db.query('SELECT id FROM incidents WHERE ref = $1', [i.ref])).rows[0].id);
    await sla.checkSlaEvents();
    await sla.checkSlaEvents();
    const breaches = (await pm.get('/api/notifications')).body.notifications.filter((x: any) => x.event === 'sla_breach' && x.ref === i.ref);
    assert.equal(breaches.length, 2, 'one per target (response, resolution), never repeated');
  });

  test('change authorisation goes to the change authority except the requester', async () => {
    const ci = (await pm.post('/api/cis', { name: 'n-box', ci_type: 'other', criticality: 4 })).body.ref;
    const c = (await pm.post('/api/changes', { title: 'Patch n-box', cis: [ci], implementation_plan: 'Patch', backout_plan: 'Unpatch', planned_start: new Date(Date.now() + 86400_000).toISOString(), planned_end: new Date(Date.now() + 90000_000).toISOString() })).body;
    await pm.post(`/api/changes/${c.ref}/transition`, { to: 'assess' });
    await pm.post(`/api/changes/${c.ref}/transition`, { to: 'authorize' });
    assert.ok((await admin.get('/api/notifications')).body.notifications.some((x: any) => x.event === 'approval_needed' && x.ref === c.ref));
    assert.ok(!(await pm.get('/api/notifications')).body.notifications.some((x: any) => x.event === 'approval_needed' && x.ref === c.ref));
    await admin.post(`/api/changes/${c.ref}/votes`, { decision: 'approve' });
    assert.ok((await pm.get('/api/notifications')).body.notifications.some((x: any) => x.event === 'decision' && x.ref === c.ref));
  });

  test('settings: per-event email, a daily digest instead of instant mail, and safe chat webhooks', async () => {
    const s = (await analyst.put('/api/notifications/settings', { events: { assigned: { email: false } } })).body;
    assert.equal(s.events.assigned.email, false);
    assert.equal(s.events.sla_breach.email, true, 'other defaults stay');
    const before = mailTo('analyst').length;
    await pm.post('/api/incidents', { title: 'For analyst', assignee_id: ids.analyst });
    await deliver();
    assert.equal(mailTo('analyst').length, before);
    assert.equal((await analyst.put('/api/notifications/settings', { chat_url: 'http://localhost:9/hook' })).status, 400);
    assert.equal((await analyst.put('/api/notifications/settings', { chat_url: 'https://169.254.169.254/x' })).status, 400);

    await pm.put('/api/notifications/settings', { digest: true });
    const instant = mailTo('pm').length;
    await analyst.post('/api/incidents', { title: 'Digest me', assignee_id: ids.pm });
    await deliver();
    assert.equal(mailTo('pm').length, instant, 'no instant mail with the digest on');
    const tomorrow8 = Date.now() + 86400_000 + 3600_000;
    assert.equal(await n.queueDigests(tomorrow8), 1);
    assert.equal(await n.queueDigests(tomorrow8), 0, 'once a day');
    await db.query("UPDATE notification_deliveries SET created_at = now() + interval '1 day', since = now() - interval '1 day' WHERE channel = 'digest'");
    await deliver();
    const digest = mailTo('pm').at(-1)!;
    assert.match(digest.subject, /Kernel: \d+ updates? since yesterday/);
    assert.match(digest.text, /Digest me/);
  });

  test('unsubscribe links are signed and work in one click', async () => {
    const url = new URL(n.unsubscribeUrl(ids.pm, 'major_incident'), 'http://x');
    const get = await new Client(k.base).request('GET', `/api/notifications/unsubscribe${url.search}`);
    assert.equal(get.status, 200);
    assert.match(String(get.body), /Stop email when: a major incident is declared\?/);
    assert.match(String(get.body), /<form method="post"/);
    assert.equal((await pm.get('/api/notifications/settings')).body.events.major_incident.email, true, 'a GET (link scanner) changes nothing');
    const confirm = await fetch(`${k.base}/api/notifications/unsubscribe${url.search}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' }, body: 'List-Unsubscribe=One-Click' });
    assert.match(await confirm.text(), /no longer receive email when: a major incident is declared/);
    assert.equal((await pm.get('/api/notifications/settings')).body.events.major_incident.email, false);
    assert.equal((await new Client(k.base).request('GET', `/api/notifications/unsubscribe?u=${ids.pm}&e=__proto__&t=x`)).status, 400);
    const forged = await new Client(k.base).request('GET', `/api/notifications/unsubscribe?u=${ids.admin}&e=all&t=${url.searchParams.get('t')}`);
    assert.equal(forged.status, 400);
    const all = new URL(n.unsubscribeUrl(ids.admin, 'all'), 'http://x');
    const res = await fetch(`${k.base}/api/notifications/unsubscribe${all.search}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(res.status, 200);
    assert.equal((await admin.get('/api/notifications/settings')).body.email, false);
  });
});
