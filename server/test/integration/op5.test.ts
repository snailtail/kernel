import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { skip, startKernel, type Client, type Harness } from './harness.js';

const SECRET = 'S3cr3t-DbPassw0rd!';
const AUTH = `Basic ${Buffer.from('kernel:op5-pw').toString('base64')}`;
const now = Math.floor(Date.now() / 1000);

/** A fake OP5 Monitor REST API: Livestatus tables with limit/offset, basic auth, and tables the user may not read. */
function fakeOp5() {
  const state = {
    hosts: [
      {
        name: 'web01.corp.local', alias: 'Web 1', address: '10.1.0.5', groups: ['linux', 'webshop'], check_command: 'check-host-alive', notes: 'Rack 4', notes_url: 'https://wiki.example.com/web01',
        custom_variables: { OWNER: 'team-web', TEAM: 'payments', DB_PASSWORD: SECRET, CI_ID: '' }, has_been_checked: 1, state: 0, state_type: 1, last_hard_state: 0, last_hard_state_change: now - 3600, acknowledged: 0, scheduled_downtime_depth: 0, plugin_output: 'PING OK',
      },
      {
        name: 'db01', alias: 'Database 1', address: '10.1.0.6', groups: ['linux'], check_command: 'check-host-alive', custom_variables: {},
        has_been_checked: 1, state: 1, state_type: 1, last_hard_state: 1, last_hard_state_change: now - 600, acknowledged: 0, scheduled_downtime_depth: 1, plugin_output: 'PING CRITICAL - Packet loss = 100%',
      },
      // Enough hosts for a second page.
      ...Array.from({ length: 1001 }, (_, n) => ({ name: `node-${String(n).padStart(4, '0')}`, address: `10.9.${n >> 8}.${n & 255}`, groups: [], has_been_checked: 1, state: 0, state_type: 1, last_hard_state: 0 })),
    ] as any[],
    services: [
      {
        'host.name': 'web01.corp.local', 'host.scheduled_downtime_depth': 0, description: 'HTTP', check_command: 'check_http!-u /health', custom_variables: { OWNER: 'team-web' },
        has_been_checked: 1, state: 2, state_type: 1, last_hard_state: 2, last_hard_state_change: now - 120, acknowledged: 1, scheduled_downtime_depth: 0, plugin_output: `CRITICAL - 500 from /health?token=${SECRET}`,
      },
      // A SOFT warning after a HARD OK: not a problem yet.
      { 'host.name': 'web01.corp.local', 'host.scheduled_downtime_depth': 0, description: 'Disk /var', check_command: 'check_disk', has_been_checked: 1, state: 1, state_type: 0, last_hard_state: 0, last_hard_state_change: now - 7200, plugin_output: 'DISK WARNING' },
      // On a host in downtime: recorded, but no incident.
      {
        'host.name': 'db01', 'host.scheduled_downtime_depth': 1, description: 'MySQL', check_command: `check_mysql!kernel!${SECRET}`,
        has_been_checked: 1, state: 3, state_type: 1, last_hard_state: 3, last_hard_state_change: now - 300, scheduled_downtime_depth: 0, plugin_output: 'UNKNOWN - connection refused',
      },
      // A service of a host OP5 no longer lists: left out.
      { 'host.name': 'gone01', description: 'PING', has_been_checked: 1, state: 0 },
    ] as any[],
    hostgroups: [{ name: 'linux', alias: 'Linux servers' }, { name: 'webshop', alias: 'Webshop' }],
    forbidden: new Set<string>(),
    requests: [] as string[],
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    state.requests.push(url.pathname + url.search);
    if (req.headers.authorization !== AUTH) return res.writeHead(401).end();
    const json = (v: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));
    const table = /^\[(\w+)\]/.exec(url.searchParams.get('query') ?? '')?.[1] ?? '';
    if (state.forbidden.has(table) || state.forbidden.has('*')) return json({ error: 'forbidden' }, 403);
    if (url.pathname === '/api/filter/count') return json({ count: (state as any)[table]?.length ?? 0 });
    if (url.pathname !== '/api/filter/query' || !(table in state)) return json({ error: 'not found' }, 404);
    const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 100);
    return json((state as any)[table].slice(offset, offset + limit));
  });
  return { server, state, listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as any).port))) };
}

describe('OP5 Monitor connector (#19)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;
  let db: typeof import('../../src/core/db.js');
  const op5 = fakeOp5();
  let port = 0;
  let id = 0;

  before(async () => {
    port = await op5.listen();
    process.env.KERNEL_SECRET_KEY = 'op5-connector-test-key-0123456789abcdef';
    process.env.KERNEL_OUTBOUND_ALLOW = '127.0.0.1';
    k = await startKernel();
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
    db = await import('../../src/core/db.js');
  });
  after(async () => {
    delete process.env.KERNEL_SECRET_KEY;
    delete process.env.KERNEL_OUTBOUND_ALLOW;
    op5.server.close();
    await k?.close();
  });

  const config = (extra: object = {}) => ({ base_url: `http://127.0.0.1:${port}`, insecure_http: true, hostgroups_as_services: true, custom_variables: ['team'], ...extra });
  const relationship = async (from: string, type: string, to: string) =>
    (await db.query(
      `SELECT 1 FROM ci_relationships r JOIN ci_sources f ON f.ci_id = r.from_ci JOIN ci_sources t ON t.ci_id = r.to_ci
       WHERE f.source_system = 'OP5 lab' AND f.source_id = $1 AND r.type = $2 AND t.source_system = 'OP5 lab' AND t.source_id = $3`,
      [from, type, to],
    )).rows.length === 1;

  test('the test tells a wrong password from a user without API rights', async () => {
    const wrong = await admin.post('/api/connectors', { type: 'op5', name: 'OP5 wrong', source_system: 'OP5 wrong', config: config(), secret: { username: 'kernel', password: 'nope' } });
    assert.equal(wrong.status, 201, JSON.stringify(wrong.body));
    assert.deepEqual((await admin.post(`/api/connectors/${wrong.body.id}/test`, {})).body, { ok: false, message: 'OP5 refused the user or password (HTTP 401)' });
    await admin.del(`/api/connectors/${wrong.body.id}`);

    const created = await admin.post('/api/connectors', { type: 'op5', name: 'OP5 lab', source_system: 'OP5 lab', config: config(), secret: { username: 'kernel', password: 'op5-pw' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    id = created.body.id;
    op5.state.forbidden.add('*');
    const forbidden = (await admin.post(`/api/connectors/${id}/test`, {})).body;
    assert.equal(forbidden.ok, false);
    assert.match(forbidden.message, /HTTP 403.*API Status/);
    op5.state.forbidden.clear();
    assert.deepEqual((await admin.post(`/api/connectors/${id}/test`, {})).body, { ok: true, message: `Connected: ${op5.state.hosts.length} hosts` });
  });

  test('the setup text describes a read-only user', async () => {
    const text = (await admin.get('/api/connectors/types/op5/setup?hostgroups_as_services=true')).body.text;
    assert.match(text, /API Status/);
    assert.match(text, /Hostgroup View All/);
    assert.match(text, /no API Config, API Command/);
    assert.doesNotMatch((await admin.get('/api/connectors/types/op5/setup')).body.text, /Hostgroup View All/, 'host group rights only when they are mapped');
    assert.equal((await pm.get('/api/connectors/types/op5/setup')).status, 403);
  });

  test('hosts, services and host groups become CIs, with relationships, source links and paged lists', async () => {
    await pm.post('/api/event-rules', { name: 'OP5 → incident', conditions: { sources: ['OP5 lab'] }, group_by: 'ci' });
    const run = (await admin.post(`/api/connectors/${id}/run`, {})).body;
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.ok(op5.state.requests.some((r) => r.includes('offset=1000')), 'the second page of hosts is read');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM ci_sources WHERE source_system = 'OP5 lab' AND source_id LIKE 'node-%'")).rows[0].n, 1001);

    const web = (await analyst.get('/api/cis?q=web01.corp.local')).body.find((c: any) => c.ci_type === 'virtual_machine');
    const detail = (await analyst.get(`/api/cis/${web.ref}`)).body;
    assert.deepEqual(
      [detail.attributes.ip, detail.attributes.fqdn, detail.attributes.alias, detail.attributes.check_command, detail.attributes.notes, detail.attributes.notes_url],
      ['10.1.0.5', 'web01.corp.local', 'Web 1', 'check-host-alive', 'Rack 4', 'https://wiki.example.com/web01'],
    );
    assert.equal(detail.sources[0].source_url, `http://127.0.0.1:${port}/monitor/index.php/extinfo/details?host=web01.corp.local`);
    // Only the allowlisted custom variables: OWNER always, TEAM because the connector names it; never DB_PASSWORD.
    assert.deepEqual([...detail.tags].sort(), ['hostgroup=linux', 'hostgroup=webshop', 'owner=team-web', 'team=payments']);
    assert.equal(JSON.stringify(detail).includes(SECRET), false);

    const mysql = (await analyst.get('/api/cis?q=MySQL')).body[0];
    assert.equal(mysql.ci_type, 'monitoring_check');
    const mysqlDetail = (await analyst.get(`/api/cis/${mysql.ref}`)).body;
    assert.equal(mysqlDetail.attributes.check_command, 'check_mysql', 'the command name only, never its arguments');
    assert.equal(mysqlDetail.sources[0].source_url, `http://127.0.0.1:${port}/monitor/index.php/extinfo/details?host=db01&service=MySQL`);
    assert.equal((await analyst.get('/api/cis?q=gone01&status=all')).body.length, 0, 'a service without a listed host is left out');

    assert.ok(await relationship('service/web01.corp.local/HTTP', 'runs_on', 'web01.corp.local'), 'a service runs on its host');
    assert.ok(await relationship('web01.corp.local', 'member_of', 'hostgroup/webshop'), 'a host is part of its host group');
    const group = (await analyst.get('/api/cis?q=Linux servers')).body[0];
    assert.equal(group.class, 'service');
  });

  test('HARD problems become alerts; downtime records them without an incident; SOFT states wait', async () => {
    const alerts = (await analyst.get('/api/alerts?source=OP5 lab')).body;
    const by = (check: string) => alerts.find((a: any) => a.check_key === check);
    assert.equal(alerts.length, 3, JSON.stringify(alerts.map((a: any) => a.check_key)));
    assert.equal(by('Disk /var'), undefined, 'a SOFT warning is not a problem yet');

    const http = by('HTTP');
    assert.equal(http.severity, 'critical');
    assert.match(http.message, /^Acknowledged in OP5\. CRITICAL: /);
    assert.equal(http.message.includes(SECRET), false, 'plugin output goes through the scanner');
    assert.equal(http.suppressed, '');
    assert.ok(http.incident_ref, 'a problem outside downtime opens an incident');
    assert.equal(http.ci_name, 'web01.corp.local / HTTP');

    const host = by('host');
    assert.deepEqual([host.severity, host.ci_name, host.incident_ref], ['critical', 'db01', null]);
    assert.equal(host.suppressed, 'Maintenance in OP5 lab');
    const mysql = by('MySQL');
    assert.deepEqual([mysql.severity, mysql.incident_ref], ['major', null], 'UNKNOWN is major; the host\'s downtime covers its services');
    assert.equal(mysql.suppressed, 'Maintenance in OP5 lab');
  });

  test('the next run is the cursor: a recovery clears, a standing problem stays one alert', async () => {
    op5.state.services[0] = { ...op5.state.services[0], state: 0, last_hard_state: 0, last_hard_state_change: now };
    const run = (await admin.post(`/api/connectors/${id}/run`, {})).body;
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.deepEqual(run.events, { reported: 2, cleared: 1 });
    const all = (await analyst.get('/api/alerts?source=OP5 lab&status=all')).body;
    assert.equal(all.find((a: any) => a.check_key === 'HTTP').status, 'closed');
    const host = all.filter((a: any) => a.check_key === 'host');
    assert.equal(host.length, 1, 'no second alert for the same problem');
    assert.deepEqual([host[0].status, host[0].count], ['open', 2]);
  });

  test('a table the user may not read leaves its CIs alone', async () => {
    op5.state.forbidden.add('services');
    const run = (await admin.post(`/api/connectors/${id}/run`, {})).body;
    op5.state.forbidden.clear();
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.equal((await db.query("SELECT max(missed_syncs)::int AS m FROM ci_sources WHERE source_system = 'OP5 lab' AND source_id LIKE 'service/%'")).rows[0].m, 0, 'no service counts a miss');
    assert.ok(await relationship('service/db01/MySQL', 'runs_on', 'db01'), 'nor loses its relationship');
    const last = (await admin.get(`/api/connectors/${id}/runs`)).body[0];
    assert.match(last.message, /not marked missing where the list was incomplete: services: not readable by the API user/);

    op5.state.forbidden.add('hostgroups');
    await admin.post(`/api/connectors/${id}/run`, {});
    op5.state.forbidden.clear();
    assert.ok(await relationship('web01.corp.local', 'member_of', 'hostgroup/linux'), 'memberships of unreadable host groups stay');
    assert.equal((await db.query("SELECT max(missed_syncs)::int AS m FROM ci_sources WHERE source_system = 'OP5 lab' AND source_id LIKE 'hostgroup/%'")).rows[0].m, 0);
  });

  test('a host that names its CI with _CI_ID joins that CI', async () => {
    const existing = (await pm.post('/api/cis', { name: 'mail-legacy', ci_type: 'virtual_machine' })).body.ref;
    op5.state.hosts.push({ name: 'mail01', address: '10.1.0.7', groups: [], custom_variables: { CI_ID: existing }, has_been_checked: 1, state: 0, state_type: 1 });
    await admin.post(`/api/connectors/${id}/run`, {});
    const ci = (await analyst.get(`/api/cis/${existing}`)).body;
    assert.ok(ci.sources.some((s: any) => s.source_system === 'OP5 lab' && s.source_id === 'mail01'), JSON.stringify(ci.sources));
    assert.equal(ci.tags.some((t: string) => t.startsWith('ci_id')), false, 'CI_ID maps, it is not a tag');
  });
});
