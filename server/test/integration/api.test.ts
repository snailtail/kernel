import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('REST API', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, viewer: Client;

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('viewer')]);
  });
  after(() => k?.close());

  const create = async (fields: Record<string, unknown> = {}) => {
    const res = await analyst.post('/api/problems', { title: 'Order service timeouts', ...fields });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };

  describe('authentication', () => {
    test('rejects bad credentials and anonymous access', async () => {
      const anon = new Client(k.base);
      assert.equal((await anon.post('/api/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
      assert.equal((await anon.get('/api/problems')).status, 401);
      assert.equal((await anon.post('/mcp', {})).status, 401);
    });

    test('returns the signed in user', async () => {
      const me = await analyst.get('/api/auth/me');
      assert.equal(me.body.username, 'analyst');
      assert.equal(me.body.role, 'analyst');
    });

    test('requires the CSRF header for cookie-authenticated changes', async () => {
      const res = await analyst.request('POST', '/api/problems', { title: 'x' }, { 'X-Kernel-Request': '' });
      assert.equal(res.status, 403);
    });

    test('logout ends the session', async () => {
      const client = await k.login('analyst2');
      await client.post('/api/auth/logout');
      assert.equal((await client.get('/api/auth/me')).status, 401);
    });

    test('API tokens authenticate until revoked', async () => {
      const created = await analyst.post('/api/tokens', { name: 'ci', expires_in_days: 1 });
      assert.match(created.body.token, /^krn_/);
      const bearer = new Client(k.base, created.body.token);
      assert.equal((await bearer.get('/api/auth/me')).body.username, 'analyst');
      // Bearer requests need no CSRF header.
      assert.equal((await bearer.post('/api/problems', { title: 'Via token' })).status, 201);
      await analyst.del(`/api/tokens/${created.body.id}`);
      assert.equal((await bearer.get('/api/auth/me')).status, 401);
    });
  });

  describe('problem lifecycle', () => {
    test('logs a problem with computed priority and activity', async () => {
      const p = await create({ impact: 1, urgency: 2, detection: 'proactive' });
      assert.match(p.ref, /^PRB\d{6}$/);
      assert.equal(p.status, 'new');
      assert.equal(p.priority, 2);
      assert.equal(p.detection, 'proactive');
      assert.equal(p.activity[0].kind, 'created');
    });

    test('validates input', async () => {
      assert.equal((await analyst.post('/api/problems', { title: '' })).status, 400);
      assert.equal((await analyst.post('/api/problems', { title: 'x', impact: 7 })).status, 400);
      assert.equal((await analyst.post('/api/problems', { title: 'x', assignee_id: 9999 })).status, 400);
    });

    test('walks the full lifecycle and enforces the rules', async () => {
      const p = await create();
      const go = (client: Client, body: object) => client.post(`/api/problems/${p.ref}/transition`, body);

      assert.equal((await go(analyst, { to: 'resolved' })).status, 409, 'cannot skip analysis');
      assert.equal((await go(analyst, { to: 'analysis' })).body.status, 'analysis');

      const ke = await go(analyst, { to: 'known_error' });
      assert.equal(ke.status, 409);
      assert.match(ke.body.error, /root cause/);

      const known = await go(analyst, { to: 'known_error', root_cause: 'Pool exhausted', workaround: 'Restart pods' });
      assert.equal(known.body.status, 'known_error');
      assert.ok(known.body.known_error_at);

      assert.equal((await go(analyst, { to: 'resolved' })).status, 409, 'needs a resolution');
      const resolved = await go(analyst, { to: 'resolved', resolution: 'Pool size raised in CHG0042' });
      assert.equal(resolved.body.status, 'resolved');

      assert.equal((await go(analyst, { to: 'closed', closure_code: 'resolved' })).status, 409, 'analysts cannot close');
      assert.equal((await go(pm, { to: 'closed' })).status, 409, 'needs a closure code');
      const closed = await go(pm, { to: 'closed', closure_code: 'resolved' });
      assert.equal(closed.body.status, 'closed');
      assert.ok(closed.body.closed_at);

      assert.equal((await analyst.patch(`/api/problems/${p.ref}`, { title: 'x' })).status, 409, 'closed problems are read only');
      assert.equal((await go(analyst, { to: 'analysis' })).status, 409, 'only managers reopen');
      const reopened = await go(pm, { to: 'analysis', comment: 'Recurred' });
      assert.equal(reopened.body.status, 'analysis');
      assert.equal(reopened.body.closed_at, null);
      assert.equal(reopened.body.closure_code, null);

      const statuses = reopened.body.activity.filter((a: any) => a.kind === 'status').map((a: any) => a.data.to);
      assert.deepEqual(statuses, ['analysis', 'closed', 'resolved', 'known_error', 'analysis']);
    });

    test('major problems need a review before closing', async () => {
      const p = (await pm.post('/api/problems', { title: 'Datacenter outage', is_major: true })).body;
      await pm.post(`/api/problems/${p.ref}/transition`, { to: 'analysis' });
      await pm.post(`/api/problems/${p.ref}/transition`, { to: 'resolved', resolution: 'Replaced UPS' });
      const res = await pm.post(`/api/problems/${p.ref}/transition`, { to: 'closed', closure_code: 'resolved' });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /major problem review/);
      const ok = await pm.post(`/api/problems/${p.ref}/transition`, { to: 'closed', closure_code: 'resolved', major_review: 'Lessons' });
      assert.equal(ok.body.status, 'closed');
    });

    test('only managers flag major problems', async () => {
      assert.equal((await analyst.post('/api/problems', { title: 'x', is_major: true })).status, 403);
      const p = await create();
      assert.equal((await analyst.patch(`/api/problems/${p.ref}`, { is_major: true })).status, 403);
      assert.equal((await pm.patch(`/api/problems/${p.ref}`, { is_major: true })).body.is_major, true);
    });

    test('viewers can read but not change', async () => {
      const p = await create();
      assert.equal((await viewer.get(`/api/problems/${p.ref}`)).status, 200);
      assert.equal((await viewer.post('/api/problems', { title: 'x' })).status, 403);
      assert.equal((await viewer.patch(`/api/problems/${p.ref}`, { title: 'x' })).status, 403);
      assert.equal((await viewer.post(`/api/problems/${p.ref}/comments`, { body: 'x' })).status, 403);
      assert.equal((await viewer.post(`/api/problems/${p.ref}/transition`, { to: 'analysis' })).status, 409);
    });

    test('updates record field changes in the activity log', async () => {
      const p = await create();
      const res = await analyst.patch(`/api/problems/${p.ref}`, { impact: 1, urgency: 1, workaround: 'Restart' });
      assert.equal(res.body.priority, 1);
      const update = res.body.activity.find((a: any) => a.kind === 'update');
      assert.deepEqual(update.data.impact, { from: 3, to: 1 });
      assert.deepEqual(update.data.workaround, { edited: true });
    });

    test('unknown problems return 404', async () => {
      assert.equal((await analyst.get('/api/problems/PRB999999')).status, 404);
    });
  });

  describe('links, notes and search', () => {
    test('links external records', async () => {
      const p = await create();
      const link = { kind: 'incident', reference: 'INC001', system: 'ServiceNow', url: 'https://sn.example/INC001' };
      const res = await analyst.post(`/api/problems/${p.ref}/links`, link);
      assert.equal(res.body.links.length, 1);
      assert.equal((await analyst.post(`/api/problems/${p.ref}/links`, link)).status, 409, 'duplicate');
      assert.equal((await analyst.post(`/api/problems/${p.ref}/links`, { ...link, reference: 'X', url: 'javascript:alert(1)' })).status, 400);
      const removed = await analyst.del(`/api/problems/${p.ref}/links/${res.body.links[0].id}`);
      assert.equal(removed.body.links.length, 0);
    });

    test('adds work notes', async () => {
      const p = await create();
      const res = await analyst.post(`/api/problems/${p.ref}/comments`, { body: 'Heap dump attached' });
      assert.equal(res.body.activity[0].kind, 'comment');
      assert.equal((await analyst.post(`/api/problems/${p.ref}/comments`, { body: '  ' })).status, 400);
    });

    test('searches with prefix matching and filters', async () => {
      const p = await create({ title: 'Kafka consumer lag on billing', affected_service: 'Billing' });
      const hits = await analyst.get('/api/problems?q=kafk%20bill');
      assert.deepEqual(hits.body.map((x: any) => x.ref), [p.ref]);
      assert.equal((await analyst.get('/api/problems?q=kafka&status=closed')).body.length, 0);
    });

    test('lists known errors in the KEDB', async () => {
      const p = await create({ title: 'Certificate expiry breaks SSO' });
      await analyst.post(`/api/problems/${p.ref}/transition`, { to: 'analysis' });
      await analyst.post(`/api/problems/${p.ref}/transition`, { to: 'known_error', root_cause: 'Manual renewal', workaround: 'Renew by hand' });
      const kedb = await viewer.get('/api/kedb?q=certificate');
      assert.deepEqual(kedb.body.map((x: any) => x.ref), [p.ref]);
    });

    test('dashboard summarises the backlog', async () => {
      const d = await analyst.get('/api/dashboard');
      assert.equal(d.status, 200);
      assert.ok(d.body.by_status.new > 0);
      assert.ok(Array.isArray(d.body.recent_activity));
    });
  });

  describe('follow-up actions', () => {
    test('adds, completes and lists actions', async () => {
      const p = await create();
      const me = (await analyst.get('/api/auth/me')).body;
      const added = await analyst.post(`/api/problems/${p.ref}/actions`, { title: 'Vendor patch', owner_id: me.id, due_date: '2000-01-01' });
      assert.equal(added.status, 201);
      const action = added.body.actions[0];
      assert.equal(action.due_date, '2000-01-01');
      assert.equal(action.overdue, true);
      assert.equal(action.owner, 'Analyst');

      const overdue = await viewer.get(`/api/actions?overdue=true&owner_id=${me.id}`);
      assert.ok(overdue.body.some((a: any) => a.id === action.id && a.ref === p.ref));
      const dash = await analyst.get('/api/dashboard');
      assert.ok(dash.body.my_actions.some((a: any) => a.id === action.id));
      assert.ok(dash.body.actions.overdue >= 1);

      const done = await analyst.patch(`/api/problems/${p.ref}/actions/${action.id}`, { status: 'done' });
      assert.equal(done.body.actions[0].status, 'done');
      assert.ok(done.body.actions[0].completed_at);
      assert.equal(done.body.activity[0].kind, 'action');
      assert.equal((await viewer.get('/api/actions?overdue=true')).body.some((a: any) => a.id === action.id), false);
      assert.equal((await analyst.post(`/api/problems/${p.ref}/actions`, { title: 'x', due_date: 'tomorrow' })).status, 400);
      assert.equal((await viewer.post(`/api/problems/${p.ref}/actions`, { title: 'x' })).status, 403);
    });

    test('closing with open actions must be acknowledged', async () => {
      const p = await create();
      await pm.post(`/api/problems/${p.ref}/actions`, { title: 'Update runbook' });
      const blocked = await pm.post(`/api/problems/${p.ref}/transition`, { to: 'closed', closure_code: 'duplicate' });
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error, /open/);
      const ok = await pm.post(`/api/problems/${p.ref}/transition`, { to: 'closed', closure_code: 'duplicate', acknowledge_open_actions: true });
      assert.equal(ok.body.status, 'closed');
    });
  });

  describe('error control', () => {
    const knownError = async () => {
      const p = await create();
      await analyst.post(`/api/problems/${p.ref}/transition`, { to: 'analysis' });
      return (await analyst.post(`/api/problems/${p.ref}/transition`, { to: 'known_error', root_cause: 'Vendor bug', workaround: 'Restart' })).body;
    };

    test('records the assessment and decision', async () => {
      const p = await knownError();
      assert.equal((await analyst.get(`/api/problems?needs_decision=true`)).body.some((x: any) => x.ref === p.ref), true);
      const assessed = await analyst.put(`/api/problems/${p.ref}/assessment`, {
        ec_risk_level: 2, ec_risk: 'Monthly outage of 10 min', ec_fix_cost: 'Vendor upgrade, 3 weeks', workaround_effectiveness: 'partial',
      });
      assert.equal(assessed.body.ec_risk_level, 2);
      assert.ok(assessed.body.workaround_reviewed_at);
      assert.equal(assessed.body.activity[0].kind, 'assessment');

      assert.equal((await analyst.put(`/api/problems/${p.ref}/assessment`, { ec_decision: 'accept' })).status, 403, 'analysts cannot accept risk');
      const fix = await analyst.put(`/api/problems/${p.ref}/assessment`, { ec_decision: 'fix' });
      assert.equal(fix.body.ec_decided_by_name, 'Analyst');
      const accepted = await pm.put(`/api/problems/${p.ref}/assessment`, { ec_decision: 'accept', ec_decision_note: 'Cheaper to live with', ec_review_date: '2000-01-01' });
      assert.equal(accepted.body.ec_decision, 'accept');
      assert.equal(accepted.body.ec_decided_by_name, 'Pm');
      assert.equal(accepted.body.ec_review_due, true);
      assert.ok((await pm.get('/api/problems?review_due=true')).body.some((x: any) => x.ref === p.ref));
      assert.equal((await pm.get('/api/problems?needs_decision=true')).body.some((x: any) => x.ref === p.ref), false);
    });

    test('closing without a fix needs an accepted risk', async () => {
      const p = await knownError();
      const blocked = await pm.post(`/api/problems/${p.ref}/transition`, { to: 'closed', closure_code: 'no_fix' });
      assert.equal(blocked.status, 409);
      await pm.put(`/api/problems/${p.ref}/assessment`, { ec_decision: 'accept' });
      assert.equal((await pm.post(`/api/problems/${p.ref}/transition`, { to: 'closed', closure_code: 'no_fix' })).body.status, 'closed');
    });

    test('decisions require a known error', async () => {
      const p = await create();
      assert.equal((await pm.put(`/api/problems/${p.ref}/assessment`, { ec_decision: 'fix' })).status, 409);
    });
  });

  describe('root cause analyses', () => {
    test('creates templates, validates data and logs sparingly', async () => {
      const p = await create();
      const created = await analyst.post(`/api/problems/${p.ref}/analyses`, { technique: 'ishikawa' });
      assert.equal(created.status, 201);
      const ishikawa = created.body.analyses[0];
      assert.equal(ishikawa.title, 'Ishikawa');
      assert.equal(ishikawa.data.categories.length, 6);

      const fw = (await analyst.post(`/api/problems/${p.ref}/analyses`, { technique: 'five_whys', title: 'Why timeouts' })).body.analyses[1];
      const data = { problem_statement: 'Orders time out', whys: [{ why: 'Why?', because: 'Pool exhausted' }] };
      const updated = await analyst.patch(`/api/problems/${p.ref}/analyses/${fw.id}`, { data, conclusion: 'Sync lookup' });
      assert.deepEqual(updated.body.analyses[1].data, data);
      assert.equal(updated.body.analyses[1].conclusion, 'Sync lookup');
      await analyst.patch(`/api/problems/${p.ref}/analyses/${fw.id}`, { conclusion: 'Sync lookup holds connections' });
      const logged = updated.body.activity.filter((a: any) => a.kind === 'analysis' && a.data.analysis_id === fw.id);
      assert.equal(logged.length, 1, 'edits right after starting are covered by the start entry');

      const bad = await analyst.patch(`/api/problems/${p.ref}/analyses/${fw.id}`, { data: { whys: 'nope' } });
      assert.equal(bad.status, 400);
      assert.equal((await analyst.post(`/api/problems/${p.ref}/analyses`, { technique: 'astrology' })).status, 400);

      const removed = await analyst.del(`/api/problems/${p.ref}/analyses/${ishikawa.id}`);
      assert.equal(removed.body.analyses.length, 1);
    });
  });

  describe('reports', () => {
    test('summarises flow, lead times and hotspots for a period', async () => {
      const p = await create({ title: 'Report me', affected_service: 'Reporting', impact: 1, urgency: 1 });
      await analyst.post(`/api/problems/${p.ref}/links`, { kind: 'incident', reference: 'INC-R1' });
      await analyst.post(`/api/problems/${p.ref}/transition`, { to: 'analysis' });
      await analyst.post(`/api/problems/${p.ref}/transition`, { to: 'known_error', root_cause: 'x' });
      const today = new Date().toISOString().slice(0, 10);
      const r = await viewer.get(`/api/reports?from=${today}&to=${today}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.period.bucket, 'week');
      assert.ok(r.body.summary.opened >= 1);
      assert.ok(r.body.summary.known_errors_raised >= 1);
      assert.equal(r.body.flow.reduce((n: number, b: any) => n + b.opened, 0), r.body.summary.opened);
      assert.ok(r.body.lead_times.some((l: any) => l.priority === 1 && l.known_error_count >= 1));
      assert.ok(r.body.hotspots.services.some((s: any) => s.name === 'Reporting' && s.incidents === 1));
      assert.equal((await viewer.get('/api/reports?from=2026-02-01&to=2026-01-01')).status, 400);
    });

    test('exports problems as CSV', async () => {
      const res = await fetch(`${k.base}/api/reports/problems.csv`, { headers: { Cookie: viewer.cookie! } });
      assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
      const lines = (await res.text()).trim().split('\r\n');
      assert.match(lines[0], /^ref,title,status,priority/);
      assert.ok(lines.length > 1);
    });
  });

  describe('administration', () => {
    test('admins manage users; others cannot', async () => {
      assert.equal((await pm.get('/api/users')).status, 403);
      const created = await admin.post('/api/users', { username: 'newbie', display_name: 'New', role: 'analyst', password: 'long enough pw' });
      assert.equal(created.status, 201);
      assert.equal((await admin.post('/api/users', { username: 'newbie', display_name: 'Dup', role: 'analyst', password: 'long enough pw' })).status, 409);
      const deactivated = await admin.patch(`/api/users/${created.body.id}`, { active: false });
      assert.equal(deactivated.body.active, false);
    });

    test('backup status is visible to managers only', async () => {
      assert.equal((await analyst.get('/api/admin/backups')).status, 403);
      assert.deepEqual((await pm.get('/api/admin/backups')).body, { configured: false });
    });

    test('managers manage categories', async () => {
      assert.equal((await analyst.post('/api/categories', { name: 'Batch' })).status, 403);
      assert.equal((await pm.post('/api/categories', { name: 'Batch' })).status, 201);
      assert.equal((await pm.post('/api/categories', { name: 'Batch' })).status, 409);
    });
  });
});
