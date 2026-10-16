import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, ownerQuery, skip, startKernel, type Harness } from './harness.js';

describe('security alerting (#64, part 2)', { skip }, () => {
  let k: Harness;
  let admin: Client, analyst: Client, analyst2: Client;
  let sec: typeof import('../../src/security-events.js');
  let run: () => Promise<any[]>;

  const origin = (ip: string) => ({ userId: null, actorType: 'anonymous', channel: 'web', tokenPrefix: '', ip, country: '', userAgent: 'test', requestId: '' });
  const failures = (ip: string, n: number, account: (i: number) => string) => {
    for (let i = 0; i < n; i++) sec.securityEvent({ action: 'auth.login_failed', category: 'authentication', outcome: 'failure', message: 'Invalid username or password', account: account(i) }, undefined, origin(ip));
  };
  // The one-off rules only read events older than a few seconds (rows may commit out of id order).
  const settle = async () => {
    await sec.flushSecurityEvents();
    await ownerQuery("UPDATE security_events SET at = at - interval '10 seconds' WHERE at > now() - interval '10 seconds'");
  };
  const alert = async (check: string) => (await ownerQuery('SELECT * FROM alerts WHERE source = $1 AND check_key = $2 ORDER BY id DESC LIMIT 1', ['Kernel security', check])).rows[0];

  before(async () => {
    k = await startKernel();
    [admin, analyst, analyst2] = await Promise.all([k.login('admin'), k.login('analyst'), k.login('analyst2')]);
    sec = await import('../../src/security-events.js');
    ({ runSecurityAlerting: run } = await import('../../src/security-alerts.js'));
  });
  after(() => k?.close());

  test('over the cap, one summary row stands for the rest of the minute', async () => {
    for (let i = 0; i < 40; i++) sec.securityEvent({ action: 'test.flood', category: 'api', outcome: 'blocked', message: 'Flood' }, undefined, origin('198.51.100.40'));
    await sec.flushSecurityEvents();
    const { rows } = await ownerQuery(`SELECT count(*)::int AS rows, sum(${sec.WEIGHT_SQL})::int AS weight, max((detail->>'suppressed')::int) AS suppressed FROM security_events WHERE action = 'test.flood'`);
    assert.deepEqual(rows[0], { rows: sec.PER_MINUTE + 1, weight: 40, suppressed: 40 - sec.PER_MINUTE - 1 });
  });

  test('a password spray from one address is counted in full; without a security team it stays an alert and tells administrators', async () => {
    // 60 failures against 60 names: past the cap of 30 rows, and past five times the threshold of 10.
    failures('203.0.113.7', 60, (i) => `sprayed-${i}`);
    await settle();
    const results = await run();
    const check = 'Failed sign-ins from 203.0.113.7';
    const hit = results.find((r) => r.check === check);
    assert.ok(hit, 'the address crossed the threshold');
    assert.equal(hit.outcome, 'no_security_team', 'a restricted incident without a team would be visible to no one');
    assert.equal(hit.incident ?? null, null);
    const a = await alert(check);
    assert.equal(a.severity, 'major', 'counted in full: 60 is five times the threshold, though only 31 rows were stored');
    assert.match(a.message, /60 failed sign-ins/);
    const status = (await admin.get('/api/admin/security')).body.checks.find((c: any) => c.id === 'security_team');
    assert.equal(status.ok, false);
    assert.match(status.detail, /Choose the team that handles security incidents/);

    const { rows: notes } = await ownerQuery("SELECT u.role FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.event = 'security_alert' AND n.title = $1", [check]);
    assert.ok(notes.length >= 1 && notes.every((n) => n.role === 'admin'), 'administrators, and only they, are notified');

    // Only administrators see security alerts: they name accounts and addresses.
    const mine = (await admin.get('/api/alerts?status=all&limit=200')).body as any[];
    assert.ok(mine.some((x) => x.check_key === check));
    const theirs = (await analyst.get('/api/alerts?status=all&limit=200')).body as any[];
    assert.ok(!theirs.some((x) => x.source === 'Kernel security'));
    assert.notEqual((await analyst.post(`/api/alerts/${a.id}/close`, {})).status, 200);

    // Repeating while the attack goes on: the same alert counts up; no second notification.
    failures('203.0.113.7', 3, (i) => `again-${i}`);
    await settle();
    assert.equal((await run()).find((r) => r.check === check)?.outcome, 'deduplicated');

    // Once the address is back under the threshold, the alert clears.
    await ownerQuery("UPDATE security_events SET at = at - interval '1 hour' WHERE ip = '203.0.113.7'");
    assert.equal((await run()).find((r) => r.check === check)?.outcome, 'cleared');
    assert.equal((await alert(check)).status, 'closed');
  });

  test('with a team, a security incident in the Security category that only the team can open', async () => {
    const { rows: [team] } = await ownerQuery("INSERT INTO teams (name) VALUES ('Security team') RETURNING id");
    await ownerQuery("INSERT INTO team_members (team_id, user_id) SELECT $1, id FROM users WHERE username = 'analyst2'", [team.id]);
    await ownerQuery("UPDATE event_rules SET team_id = $1 WHERE name = 'Security alerts'", [team.id]);
    assert.equal((await admin.get('/api/admin/security')).body.checks.find((c: any) => c.id === 'security_team').ok, true);
    assert.equal((await admin.get('/api/admin/security-alerting')).body.rules[0].team_name, 'Security team');

    failures('203.0.113.8', 12, (i) => `team-${i}`);
    await settle();
    const hit = (await run()).find((r) => r.check === 'Failed sign-ins from 203.0.113.8');
    assert.equal(hit?.outcome, 'incident_created');
    const { rows: [inc] } = await ownerQuery('SELECT i.restricted, i.restricted_teams, i.source, c.name AS category FROM incidents i LEFT JOIN categories c ON c.id = i.category_id WHERE i.ref = $1', [hit.incident]);
    assert.deepEqual(inc, { restricted: true, restricted_teams: [team.id], source: 'event', category: 'Security' });
    assert.equal((await analyst2.get(`/api/incidents/${hit.incident}`)).status, 200, 'the security team opens it');
    assert.equal((await analyst.get(`/api/incidents/${hit.incident}`)).status, 404, 'anyone else: not even its existence shows');
  });

  test('failed sign-ins for one account, and erasure removes its name from the alert', async () => {
    const created = await admin.post('/api/users', { username: 'target.user', display_name: 'Target User', role: 'viewer', password: 'a fine long passphrase' });
    assert.equal(created.status, 201);
    for (let i = 0; i < 12; i++) failures(`192.0.2.${i + 1}`, 1, () => 'target.user');
    await settle();
    const check = 'Failed sign-ins for target.user';
    assert.ok((await run()).some((r) => r.check === check));
    assert.match((await alert(check)).message, /from 12 addresses/);

    assert.equal((await admin.post(`/api/users/${created.body.id}/erase`, { reason: 'Erasure request 12' })).status, 200);
    const { rows } = await ownerQuery("SELECT count(*)::int AS n FROM alerts WHERE source = 'Kernel security' AND (check_key || message) LIKE '%target.user%'");
    assert.equal(rows[0].n, 0);
    assert.ok(await alert(`Failed sign-ins for deleted user #${created.body.id}`));
  });

  test('a new administrator, and a sign-in from a new country', async () => {
    const created = await admin.post('/api/users', { username: 'newadmin', display_name: 'New Admin', role: 'admin', password: 'a fine long passphrase' });
    assert.equal(created.status, 201);
    const uid = created.body.id;
    for (const country of ['SE', 'SE', 'BR']) {
      await ownerQuery("INSERT INTO security_events (action, category, outcome, user_id, ip, country, at) VALUES ('session.login', 'authentication', 'success', $1, '192.0.2.200', $2, now() - interval '1 minute')", [uid, country]);
    }
    await settle();
    const results = await run();
    assert.ok(results.some((r) => r.check === 'New administrator: newadmin'));
    const countries = results.filter((r) => r.check.startsWith('Sign-in from a new country: newadmin'));
    assert.deepEqual(countries.map((r) => r.check), ['Sign-in from a new country: newadmin (BR)'], 'not the first known country, nor a repeat');
  });

  test('the source name is reserved, and catch-all rules never take security alerts', async () => {
    const res = await admin.post('/api/events', { source: 'kernel security', events: [{ check: 'Failed sign-ins from 1.2.3.4', severity: 'critical' }] });
    assert.equal(res.status, 400);
    const hook = await admin.post('/api/event-sources', { name: 'Kernel Security', kind: 'generic' });
    assert.equal(hook.status, 400);

    await ownerQuery("UPDATE event_rules SET enabled = false WHERE name = 'Security alerts'");
    await ownerQuery("INSERT INTO event_rules (name, position, conditions) VALUES ('Catch all', 0, '{}')");
    try {
      failures('203.0.113.99', 12, (i) => `catch-${i}`);
      await settle();
      const hit = (await run()).find((r) => r.check === 'Failed sign-ins from 203.0.113.99');
      assert.equal(hit?.outcome, 'opened', 'an alert, but no incident from a rule that does not name the source');
    } finally {
      await ownerQuery("DELETE FROM event_rules WHERE name = 'Catch all'");
      await ownerQuery("UPDATE event_rules SET enabled = true WHERE name = 'Security alerts'");
    }
  });

  test('settings: thresholds and retention, administrators only, with a reason and limits', async () => {
    const status = await admin.get('/api/admin/security-alerting');
    assert.equal(status.status, 200);
    assert.equal(status.body.rules[0].name, 'Security alerts');
    assert.equal((await analyst.get('/api/admin/security-alerting')).status, 403);
    const settings = { ...status.body.settings, denials: { enabled: true, threshold: 50, window_minutes: 5 } };
    assert.equal((await admin.put('/api/admin/security-alerting', settings)).status, 400, 'a reason is required');
    const saved = await admin.put('/api/admin/security-alerting', { ...settings, reason: 'Fewer false alarms from the scanner' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.denials.threshold, 50);

    assert.equal((await admin.put('/api/admin/privacy', { audit_context_days: 365, security_event_days: 7, reason: 'Shorter' })).status, 400, 'never under 30 days');
    const kept = await admin.put('/api/admin/privacy', { audit_context_days: 180, security_event_days: 90, reason: 'Retention review' });
    assert.equal(kept.status, 200);
    assert.deepEqual({ a: kept.body.audit_context_days, s: kept.body.security_event_days }, { a: 180, s: 90 });
    const { rows } = await ownerQuery("SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'setting' AND entity_ref IN ('privacy', 'security_alerting')");
    assert.equal(rows[0].n, 2, 'both changes are audited');
  });
});
