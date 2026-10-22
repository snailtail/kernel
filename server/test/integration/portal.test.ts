import assert from 'node:assert/strict';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { after, before, describe, test } from 'node:test';
import { Client, ownerQuery, skip, startKernel, type Harness } from './harness.js';

const ok = (r: { status: number; body: unknown }) => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);

describe('self-service portal (#45, part 1)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;
  let n: typeof import('../../src/notifications.js');
  let portal: typeof import('../../src/portal.js');
  const ids: Record<string, number> = {};
  const people: Record<string, number> = {};
  const services: Record<string, string> = {};
  let team = 0;
  // Eva's portal session, from the boundary test on (sign-in links are limited per address and per address an hour).
  let eva: Client;

  /** Signs a person in through a mailed link, as the portal page does. */
  const signIn = async (email: string) => {
    const c = new Client(k.base);
    ok(await c.post('/api/portal/auth/link', { email }));
    await portal.processPortalMail();
    const mail = n.capturedMail.filter((m) => m.to === email).at(-1)!;
    const token = mail.text.match(/\/portal\/signin\?token=([\w-]+)/)![1];
    ok(await c.post('/api/portal/auth/signin', { token }));
    return { c, token };
  };

  before(async () => {
    process.env.SMTP_URL = 'capture:';
    process.env.KERNEL_SECRET_KEY = 'portal-test-key-0123456789abcdefghijklmno';
    k = await startKernel();
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
    n = await import('../../src/notifications.js');
    portal = await import('../../src/portal.js');
    for (const u of (await admin.get('/api/users')).body) ids[u.username] = u.id;
    services.mail = (await pm.post('/api/cis', { name: 'Mail', ci_type: 'business_service' })).body.ref;
    services.payroll = (await pm.post('/api/cis', { name: 'Payroll', ci_type: 'business_service' })).body.ref;
    services.secret = (await pm.post('/api/cis', { name: 'Internal billing engine', ci_type: 'business_service' })).body.ref;
    await ownerQuery('UPDATE configuration_items SET in_catalogue = true WHERE ref = $1', [services.payroll]);
    const org = (await admin.post('/api/organisations', { name: 'Acme', kind: 'customer', services: [services.mail] })).body.id;
    team = (await admin.post('/api/teams', { name: 'Workplace' })).body.id;
    ok(await admin.put(`/api/teams/${team}/members`, { members: [{ user_id: ids.analyst, role: 'lead' }] }));
    people.eva = (await analyst.post('/api/people', { name: 'Eva Enduser', email: 'eva@example.org', organisation_id: org })).body.id;
    people.olle = (await analyst.post('/api/people', { name: 'Olle Other', email: 'olle@example.org' })).body.id;
  });
  after(async () => {
    delete process.env.SMTP_URL;
    await k?.close();
  });

  test('the module is off by default: the page and its API do not exist', async () => {
    const anon = new Client(k.base);
    assert.equal((await anon.get('/portal')).status, 404);
    assert.equal((await anon.get('/portal/tickets/INC000001')).status, 404);
    assert.equal((await anon.get('/api/portal/me')).status, 404);
    assert.equal((await anon.post('/api/portal/auth/link', { email: 'eva@example.org' })).status, 404);
    ok(await admin.put('/api/admin/modules', { portal: true, reason: 'End users get a front door' }));
    assert.equal((await anon.get('/portal')).status, 200);
    assert.equal((await anon.get('/api/portal/me')).status, 401);
  });

  test('sign-in by link: the same answer for any address, hash only, 15 minutes, single use', async () => {
    const anon = new Client(k.base);
    const known = await anon.post('/api/portal/auth/link', { email: 'Eva@Example.org' });
    const unknown = await anon.post('/api/portal/auth/link', { email: 'nobody@example.org' });
    assert.deepEqual(known.body, unknown.body);
    const before = n.capturedMail.length;
    await portal.processPortalMail();
    const sent = n.capturedMail.slice(before);
    assert.deepEqual(sent.map((m) => m.to), ['eva@example.org'], 'only a known person gets mail');
    const token = sent[0].text.match(/\/portal\/signin\?token=([\w-]+)/)![1];
    assert.ok(token.length >= 43, '256 bits');
    const { rows } = await ownerQuery('SELECT token_hash, expires_at - created_at AS ttl FROM portal_links WHERE person_id = $1', [people.eva]);
    assert.ok(!rows.some((r) => r.token_hash.includes(token)), 'only the hash is stored');
    assert.equal(rows[0].ttl.minutes, 15);
    const c = new Client(k.base);
    ok(await c.post('/api/portal/auth/signin', { token }));
    assert.ok(c.cookies.has('kernel_portal'));
    assert.equal((await c.get('/api/portal/me')).body.name, 'Eva Enduser');
    const { rows: s } = await ownerQuery("SELECT extract(epoch FROM expires_at - created_at) / 3600 AS hours FROM portal_sessions WHERE person_id = $1", [people.eva]);
    assert.equal(Math.round(Number(s[0].hours)), 8);
    // Used once; a second use is refused and recorded.
    const again = await new Client(k.base).post('/api/portal/auth/signin', { token });
    assert.equal(again.status, 400);
    await new Promise((r) => setTimeout(r, 200));
    const { rows: ev } = await ownerQuery("SELECT action FROM security_events WHERE action LIKE 'portal.%'");
    assert.ok(ev.some((e) => e.action === 'portal.link_refused'));
    assert.ok(ev.some((e) => e.action === 'portal.link_unknown'));
  });

  test('five links per address an hour, quietly: the same answer, no more mail', async () => {
    const anon = new Client(k.base);
    await ownerQuery("DELETE FROM portal_mail WHERE person_id = $1", [people.olle]);
    for (let i = 0; i < 7; i++) ok(await anon.post('/api/portal/auth/link', { email: 'olle@example.org' }));
    const { rows } = await ownerQuery("SELECT count(*)::int AS n FROM portal_mail WHERE kind = 'signin' AND person_id = $1", [people.olle]);
    assert.equal(rows[0].n, 5);
    await portal.processPortalMail();
  });

  test('a portal session authorises nothing in Kernel: every operation answers 401', async () => {
    const { c } = await signIn('eva@example.org');
    eva = c;
    const { OPERATIONS } = await import('../../src/openapi.js');
    const fill = (p: string) => p.replace(/:ref/g, 'INC000001').replace(/:[a-z_]+/g, '1');
    const failures: string[] = [];
    for (const op of OPERATIONS) {
      if (op.public || !op.path.startsWith('/api/') || op.path.startsWith('/api/portal/')) continue;
      const res = await c.request(op.method.toUpperCase(), fill(op.path), op.method === 'get' || op.method === 'delete' ? undefined : {});
      if (res.status !== 401) failures.push(`${op.method} ${op.path} → ${res.status}`);
    }
    assert.deepEqual(failures, []);
    // And the other way round: Kernel's session is not a portal session.
    assert.equal((await analyst.get('/api/portal/me')).status, 401);
    // Changes need the same header as Kernel's own UI.
    assert.equal((await c.request('POST', '/api/portal/problems', { what: 'It is broken', affected: 'me' }, { 'X-Kernel-Request': '' })).status, 403);
  });

  test('report a problem: services from the organisation and the catalogue, a fixed priority, the person as caller', async () => {
    const c = eva;
    // An organisation's service without a public name stays internal; with one, it shows under that name.
    assert.deepEqual((await c.get('/api/portal/services')).body.map((s: any) => s.name), ['Payroll']);
    ok(await pm.put(`/api/status/${services.mail}/public`, { public: true, public_name: 'Email' }));
    const svc = (await c.get('/api/portal/services')).body.map((s: any) => s.name).sort();
    assert.deepEqual(svc, ['Email', 'Payroll']);
    assert.equal((await c.post('/api/portal/problems', { service: services.secret, what: 'Billing is down', affected: 'me' })).status, 400);
    const t = await c.post('/api/portal/problems', { service: services.mail, what: 'My mail does not arrive\nSince this morning nothing comes in.', affected: 'many' });
    ok(t);
    assert.equal(t.body.title, 'My mail does not arrive');
    assert.equal(t.body.status_label, 'Received');
    const inc = (await analyst.get(`/api/incidents/${t.body.ref}`)).body;
    assert.equal(inc.source, 'portal');
    assert.equal(inc.caller.id, people.eva);
    assert.deepEqual([inc.impact, inc.urgency], [1, 2]);
    assert.ok(inc.affected_services.some((s: any) => s.ref === services.mail) || inc.affected_cis.some((s: any) => s.ref === services.mail));
    const { rows } = await ownerQuery("SELECT actor_type, channel FROM audit_log WHERE entity_ref = $1 AND action = 'created'", [t.body.ref]);
    assert.deepEqual(rows[0], { actor_type: 'portal', channel: 'portal' });
  });

  test('help articles for end users are suggested while typing; internal ones never', async () => {
    for (const [title, audience] of [['Mail does not arrive: check the quota', 'end_users'], ['Mail relay runbook for the platform team', 'internal']]) {
      const a = (await pm.post('/api/articles', { title, body: `${title}. Steps…` })).body;
      await ownerQuery("UPDATE articles SET status = 'published', audience = $2 WHERE ref = $1", [a.ref, audience]);
    }
    const c = eva;
    const s = (await c.get('/api/portal/suggestions?q=mail%20arrive')).body;
    assert.deepEqual(s.map((a: any) => a.title), ['Mail does not arrive: check the quota']);
    assert.ok((await c.get(`/api/portal/articles/${s[0].ref}`)).body.body.includes('Steps'));
    const internal = (await ownerQuery("SELECT ref FROM articles WHERE audience = 'internal'")).rows[0].ref;
    assert.equal((await c.get(`/api/portal/articles/${internal}`)).status, 404);
  });

  test('my tickets show only replies written for the person, never notes, assignees or other people', async () => {
    const c = eva;
    const ref = (await c.post('/api/portal/problems', { what: 'Printer on floor 3 jams', affected: 'some' })).body.ref;
    ok(await analyst.patch(`/api/incidents/${ref}`, { team_id: team, assignee_id: ids.analyst }));
    ok(await analyst.post(`/api/incidents/${ref}/comments`, { body: 'Internal: Olle broke it last week' }));
    ok(await analyst.post(`/api/incidents/${ref}/comments`, { body: 'We are sending someone to look at it today.', to_requester: true }));
    const t = (await c.get(`/api/portal/tickets/${ref}`)).body;
    assert.equal(t.handled_by, 'Workplace');
    assert.deepEqual(t.updates.map((u: any) => [u.from, u.by, u.body]), [['it', 'Workplace', 'We are sending someone to look at it today.']]);
    const text = JSON.stringify(t) + JSON.stringify((await c.get('/api/portal/tickets')).body);
    for (const secret of ['Olle', 'Analyst', 'analyst', 'priority', 'impact', 'category', 'sla']) assert.ok(!text.includes(secret), `no "${secret}"`);
    // The reply goes by mail too, with an unsubscribe link; the internal note does not.
    await portal.processPortalMail();
    const mail = n.capturedMail.filter((m) => m.to === 'eva@example.org' && m.subject === `Reply on ${ref}`);
    assert.equal(mail.length, 1);
    assert.ok(mail[0].text.includes('We are sending someone') && !mail[0].text.includes('Olle'));
    assert.match(mail[0].text, /Unsubscribe: \S*\/status\/unsubscribe\?r=\d+&token=/);
    // Someone else's ticket does not exist for her.
    const other = (await analyst.post('/api/incidents', { title: 'Olle cannot log in', caller: { id: people.olle } })).body.ref;
    assert.equal((await c.get(`/api/portal/tickets/${other}`)).status, 404);
    assert.equal((await c.post(`/api/portal/tickets/${other}/messages`, { body: 'Hi' })).status, 404);
  });

  test('adding information becomes a comment marked as the requester’s, and agents get it as untrusted text', async () => {
    const c = eva;
    const ref = (await c.get('/api/portal/tickets')).body.find((t: any) => t.title === 'Printer on floor 3 jams').ref;
    const t = (await c.post(`/api/portal/tickets/${ref}/messages`, { body: 'It shows error E-42.' })).body;
    assert.deepEqual(t.updates.at(-1), { at: t.updates.at(-1).at, from: 'you', by: 'You', body: 'It shows error E-42.' });
    // Scanned like everything else written into Kernel (#61): a secret never reaches the record.
    const secret = await c.post(`/api/portal/tickets/${ref}/messages`, { body: 'My key is AKIAIOSFODNN7EXAMPLE' });
    assert.equal(secret.headers.get('x-kernel-redacted'), 'aws-key');
    assert.ok(!JSON.stringify(secret.body).includes('AKIAIOSFODNN7EXAMPLE'));
    const inc = (await analyst.get(`/api/incidents/${ref}`)).body;
    const a = inc.activity.find((x: any) => x.body === 'It shows error E-42.');
    assert.deepEqual([a.kind, a.data.from_requester, a.channel], ['comment', true, 'portal']);
    const mcp = new McpClient({ name: 'portal', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const r: any = await mcp.callTool({ name: 'get_incident', arguments: { ref } });
    const forAgent = JSON.parse(r.content[0].text);
    const note = forAgent.untrusted_content.notes.find((x: any) => x.note === 'It shows error E-42.');
    assert.deepEqual([note.by, note.from_requester], ['the caller (portal)', true]);
    assert.ok(forAgent.untrusted_content.notes.some((x: any) => x.to_requester), 'replies sent to the caller are marked too');
    await mcp.close();
  });

  test('a restricted record shows its ref and status only, and a reply to it is refused', async () => {
    const c = eva;
    const ref = (await c.post('/api/portal/problems', { what: 'Someone used my account', affected: 'me' })).body.ref;
    ok(await analyst.post(`/api/incidents/${ref}/comments`, { body: 'Checking the sign-in logs now.', to_requester: true }));
    await ownerQuery('UPDATE incidents SET restricted = true, restricted_teams = $2 WHERE ref = $1', [ref, [team]]);
    const t = (await c.get(`/api/portal/tickets/${ref}`)).body;
    assert.equal(t.title, null);
    assert.deepEqual(t.updates, []);
    assert.equal(t.handled_by, 'IT service desk');
    assert.equal((await analyst.post(`/api/incidents/${ref}/comments`, { body: 'More', to_requester: true })).status, 400);
    // No caller, no reply.
    const none = (await analyst.post('/api/incidents', { title: 'No caller' })).body.ref;
    assert.equal((await analyst.post(`/api/incidents/${none}/comments`, { body: 'Hello?', to_requester: true })).status, 400);
  });

  test('"Still a problem" reopens a solved report, "It works" closes it, and only once', async () => {
    const c = eva;
    const ref = (await c.post('/api/portal/problems', { what: 'VPN drops every hour', affected: 'me' })).body.ref;
    const resolve = () => analyst.post(`/api/incidents/${ref}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Raised the VPN timeout' });
    assert.equal((await c.post(`/api/portal/tickets/${ref}/confirm`, { works: true })).status, 409, 'not solved yet');
    ok(await analyst.post(`/api/incidents/${ref}/transition`, { to: 'in_progress' }));
    ok(await resolve());
    assert.equal((await c.get(`/api/portal/tickets/${ref}`)).body.can.confirm, true);
    const reopened = (await c.post(`/api/portal/tickets/${ref}/confirm`, { works: false, body: 'It dropped again at 10:00' })).body;
    assert.equal(reopened.status, 'in_progress');
    let inc = (await analyst.get(`/api/incidents/${ref}`)).body;
    assert.equal(inc.reopen_count, 1);
    ok(await resolve());
    const closed = (await c.post(`/api/portal/tickets/${ref}/confirm`, { works: true })).body;
    assert.equal(closed.status_label, 'Closed');
    inc = (await analyst.get(`/api/incidents/${ref}`)).body;
    assert.equal(inc.status, 'closed');
    assert.equal((await c.post(`/api/portal/tickets/${ref}/confirm`, { works: false })).status, 409);
    assert.equal((await c.post(`/api/portal/tickets/${ref}/messages`, { body: 'Hello' })).status, 409, 'closed: report it again');
  });

  test('requests made for the person are in my tickets, with replies to the requester', async () => {
    ok(await admin.put('/api/admin/modules', { request: true, reason: 'Requests too' }));
    const item = (await pm.post('/api/request-items', { service: services.payroll, name: 'Payslip copy', form: [], fulfilment_tasks: [{ title: 'Send it', team_id: team }] })).body.id;
    const r = (await analyst.post('/api/requests', { item_id: item, requester: { id: people.eva }, answers: {} })).body;
    ok(await analyst.post(`/api/requests/${r.ref}/comments`, { body: 'Internal: check her contract first' }));
    ok(await analyst.post(`/api/requests/${r.ref}/comments`, { body: 'Which month do you need?', to_requester: true }));
    const c = eva;
    const t = (await c.get(`/api/portal/tickets/${r.ref}`)).body;
    assert.equal(t.kind, 'request');
    assert.deepEqual(t.updates.map((u: any) => u.body), ['Which month do you need?']);
    ok(await c.post(`/api/portal/tickets/${r.ref}/messages`, { body: 'March, please.' }));
    const req = (await analyst.get(`/api/requests/${r.ref}`)).body;
    assert.ok(req.activity.some((a: any) => a.body === 'March, please.' && a.data.from_requester));
  });

  test('signing out ends the session, and turning the module off closes the portal', async () => {
    const c = eva;
    ok(await c.post('/api/portal/auth/logout'));
    assert.equal((await c.get('/api/portal/me')).status, 401);
    const { c: d } = await signIn('eva@example.org');
    ok(await admin.put('/api/admin/modules', { portal: false, reason: 'Testing' }));
    assert.equal((await d.get('/api/portal/me')).status, 404);
    assert.equal((await d.get('/portal')).status, 404);
  });
});
