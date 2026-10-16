// Problem candidates (part 1 of #31): every rule finds what it should (positive), not what it should not (negative),
// and stays away once dismissed until new evidence is enough on its own. Plus reported candidates, decisions, rule
// settings, the prefilled problem, and row-level security deciding what counts.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client, ownerQuery, skip, startKernel, type Harness } from './harness.js';

const ok = (r: { status: number; body: unknown }, status?: number) =>
  assert.ok(status ? r.status === status : r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);

describe('problem candidates (#31)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, viewer: Client;
  let n = 0;

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('viewer')]);
  });
  after(() => k?.close());

  const ci = async (name: string, ci_type = 'application') => (await pm.post('/api/cis', { name: `${name}-${++n}`, ci_type })).body.ref as string;
  const incident = async (body: object, as: Client = analyst) => {
    const r = await as.post('/api/incidents', { title: `Incident ${++n}`, impact: 3, urgency: 3, ...body });
    ok(r, 201);
    return r.body.ref as string;
  };
  const resolve = async (ref: string, resolution_code = 'fixed') =>
    ok(await analyst.post(`/api/incidents/${ref}/transition`, { to: 'resolved', resolution_code, resolution: 'Done' }));
  const list = async (as: Client = analyst, q = '') => (await as.get(`/api/candidates${q}`)).body;
  const find = async (key: string, as: Client = analyst, q = '') => (await list(as, q)).candidates.find((c: any) => c.key === key);
  const setRule = async (rule: string, body: object) => ok(await pm.put(`/api/candidates/rules/${rule}`, body));

  test('the rules are listed with their settings, and changing one is audited', async () => {
    const body = await list(viewer);
    assert.deepEqual(body.rules.map((r: any) => r.rule), ['recurring_records', 'common_upstream', 'major_without_problem', 'recurring_resolution', 'reported']);
    assert.deepEqual(body.rules[0].settings, { min_records: 5, window_days: 7 }, 'the old single rule became recurring_records, defaults kept');
    assert.equal((await analyst.put('/api/candidates/rules/common_upstream', { enabled: false })).status, 403);
    assert.equal((await pm.put('/api/candidates/rules/nonsense', { enabled: false })).status, 404);
    assert.equal((await pm.put('/api/candidates/rules/common_upstream', { settings: { min_cis: 1 } })).status, 400, 'thresholds are validated');
    const changed = await pm.put('/api/candidates/rules/common_upstream', { settings: { max_depth: 4 } });
    ok(changed);
    assert.deepEqual(changed.body.settings, { min_records: 3, min_cis: 2, window_days: 7, max_depth: 4 }, 'other settings keep their values');
    const { rows } = await ownerQuery("SELECT changes FROM audit_log WHERE entity_type = 'setting' AND entity_ref = 'candidate_rule:common_upstream' ORDER BY id DESC LIMIT 1");
    assert.equal(rows[0].changes.settings.to.max_depth, 4);
    await setRule('common_upstream', { settings: { max_depth: 3 } });
  });

  test('recurring records: a CI with enough unlinked incidents, with a reason; not below the threshold', async () => {
    await setRule('recurring_records', { settings: { min_records: 3, window_days: 7 } });
    const hit = await ci('orders-api'), miss = await ci('orders-ui');
    for (let i = 0; i < 3; i++) await incident({ cis: [hit] });
    for (let i = 0; i < 2; i++) await incident({ cis: [miss] });
    const c = await find(`recurring_records:ci:${hit}`);
    assert.equal(c.rule, 'recurring_records');
    assert.match(c.reason, new RegExp(`^3 incidents on orders-api-\\d+ \\(${hit}\\) in 7 days, none linked to a problem$`));
    assert.equal(c.evidence.records.length, 3);
    assert.ok(c.evidence.records.every((r: any) => r.key.startsWith('i:INC') && r.ci_ref === hit));
    assert.equal(await find(`recurring_records:ci:${miss}`), undefined, 'two incidents are below the threshold');
    assert.equal((await list(analyst, '?rule=common_upstream')).candidates.some((x: any) => x.rule !== 'common_upstream'), false, 'filter by rule');
  });

  test('a dismissal needs a reason and holds until new evidence meets the rule on its own; restore undoes it', async () => {
    const app = await ci('billing');
    for (let i = 0; i < 3; i++) await incident({ cis: [app] });
    const key = `recurring_records:ci:${app}`;
    assert.equal((await viewer.post('/api/candidates/dismiss', { key, reason: 'Known noise' })).status, 403);
    assert.equal((await analyst.post('/api/candidates/dismiss', { key, reason: '' })).status, 400, 'a reason is required');
    ok(await analyst.post('/api/candidates/dismiss', { key, reason: 'Load test noise' }));
    assert.equal(await find(key), undefined);
    const hidden = await find(key, analyst, '?show=hidden');
    assert.equal(hidden.decision.decision, 'dismissed');
    assert.equal(hidden.decision.reason, 'Load test noise');
    assert.ok((await list()).hidden.dismissed >= 1);
    const { rows } = await ownerQuery("SELECT action, reason FROM audit_log WHERE entity_type = 'problem_candidate' AND entity_ref = $1", [key]);
    assert.deepEqual(rows.map((r: any) => [r.action, r.reason]), [['dismiss', 'Load test noise']]);

    // One more incident is not enough on its own (3 needed); three more are, and only they are shown.
    await incident({ cis: [app] });
    assert.equal(await find(key), undefined, 'still dismissed with one new incident');
    await incident({ cis: [app] });
    await incident({ cis: [app] });
    const back = await find(key);
    assert.equal(back.count, 3, 'only the new evidence');

    ok(await analyst.post('/api/candidates/dismiss', { key, reason: 'Still noise' }));
    ok(await analyst.post('/api/candidates/restore', { key }));
    assert.equal((await find(key)).count, 6, 'restored with all its evidence');
    assert.equal((await analyst.post('/api/candidates/restore', { key })).status, 404);
  });

  test('a snooze hides a candidate until its time, whatever arrives meanwhile', async () => {
    const app = await ci('search');
    for (let i = 0; i < 3; i++) await incident({ cis: [app] });
    const key = `recurring_records:ci:${app}`;
    assert.equal((await analyst.post('/api/candidates/dismiss', { key, reason: 'Release', until: new Date(Date.now() - 60_000).toISOString() })).status, 400, 'not in the past');
    ok(await analyst.post('/api/candidates/dismiss', { key, reason: 'Wait for the release on Friday', until: new Date(Date.now() + 86_400_000).toISOString() }));
    for (let i = 0; i < 3; i++) await incident({ cis: [app] });
    assert.equal(await find(key), undefined, 'snoozed, even with new incidents');
    assert.equal((await find(key, analyst, '?show=hidden')).decision.decision, 'snoozed');
    await ownerQuery("UPDATE candidate_decisions SET until = now() - interval '1 minute' WHERE key = $1", [key]);
    assert.equal((await find(key)).count, 6, 'back when the snooze ends');
  });

  test('common underlying CI: incidents on different CIs that depend on the same CI; the closest one wins', async () => {
    const host = await ci('esx-07', 'virtual_machine'), cluster = await ci('esx-cluster', 'virtual_machine');
    const a = await ci('crm'), b = await ci('hr-portal');
    ok(await pm.post(`/api/cis/${a}/relationships`, { type: 'runs_on', target: host }));
    ok(await pm.post(`/api/cis/${b}/relationships`, { type: 'runs_on', target: host }));
    ok(await pm.post(`/api/cis/${host}/relationships`, { type: 'runs_on', target: cluster }));
    const refs = [await incident({ cis: [a] }), await incident({ cis: [a] }), await incident({ cis: [b] })];
    const c = await find(`common_upstream:ci:${host}`);
    assert.ok(c, 'found');
    assert.match(c.reason, new RegExp(`^3 incidents on 2 different CIs in 7 days all depend on esx-07-\\d+ \\(${host}\\)`));
    assert.deepEqual(c.evidence.records.map((r: any) => r.incident_ref).sort(), refs.sort());
    assert.deepEqual(c.evidence.cis[0], { ref: host, name: c.subject.name, role: 'upstream' });
    assert.deepEqual(c.evidence.cis.filter((x: any) => x.role === 'affected').map((x: any) => x.ref).sort(), [a, b].sort());
    assert.equal(await find(`common_upstream:ci:${cluster}`), undefined, 'the cluster explains the same incidents, so only the closer host is shown');

    // Negative: the same number of incidents, all on one CI.
    const lone = await ci('lone-app'), lonehost = await ci('lone-host', 'virtual_machine');
    ok(await pm.post(`/api/cis/${lone}/relationships`, { type: 'runs_on', target: lonehost }));
    for (let i = 0; i < 3; i++) await incident({ cis: [lone] });
    assert.equal(await find(`common_upstream:ci:${lonehost}`), undefined, 'one CI is not a shared dependency');

    // Dismissed: gone; a new incident alone is not enough.
    ok(await analyst.post('/api/candidates/dismiss', { key: c.key, reason: 'Host was patched, reviewed with the team' }));
    assert.equal(await find(c.key), undefined);
    await incident({ cis: [b] });
    assert.equal(await find(c.key), undefined);
  });

  test('major incident resolved without a problem; logged from its key as a reactive problem', async () => {
    const app = await ci('payments');
    const major = await incident({ title: 'Payments down for all customers', impact: 1, urgency: 1, cis: [app] });
    ok(await pm.post(`/api/incidents/${major}/major`, {}));
    const child = await incident({ title: 'Card payment fails', cis: [app] });
    ok(await pm.post(`/api/incidents/${major}/children`, { child }));
    const key = `major_without_problem:incident:${major}`;
    assert.equal(await find(key), undefined, 'not while it is open');
    await resolve(major);
    const c = await find(key);
    assert.match(c.reason, new RegExp(`^Major incident ${major} was resolved \\d{4}-\\d{2}-\\d{2} without a problem record`));

    // Negative: an ordinary resolved incident, and a major one that has a problem.
    const plain = await incident({ cis: [app] });
    await resolve(plain);
    assert.equal(await find(`major_without_problem:incident:${plain}`), undefined);
    const handled = await incident({ title: 'Login down', impact: 1, urgency: 1 });
    ok(await pm.post(`/api/incidents/${handled}/major`, {}));
    await resolve(handled);
    ok(await analyst.post(`/api/incidents/${handled}/problem`, {}));
    assert.equal(await find(`major_without_problem:incident:${handled}`), undefined);

    const draft = (await analyst.get(`/api/candidates/draft?key=${encodeURIComponent(key)}`)).body;
    assert.equal(draft.title, `Underlying cause of major incident ${major}: Payments down for all customers`);
    assert.equal(draft.detection, 'reactive');
    const created = await analyst.post('/api/candidates/create', { key, problem: { urgency: 1 } });
    ok(created, 201);
    assert.equal(created.body.title, draft.title);
    assert.equal(created.body.detection, 'reactive');
    assert.equal(created.body.urgency, 1, 'given fields override the prefill');
    assert.match(created.body.description, /Identified from a problem candidate \(Major incident resolved without a problem\)/);
    assert.deepEqual(created.body.incidents.map((i: any) => i.ref).sort(), [major, child].sort(), 'with its related incident');
    const { rows: linkedChild } = await ownerQuery("SELECT count(*)::int AS n FROM problem_activity a JOIN problems p ON p.id = a.problem_id WHERE p.ref = $1 AND a.body = $2", [created.body.ref, `Linked incident ${child}`]);
    assert.equal(linkedChild[0].n, 1, 'linked once, though it is both evidence and a related incident');
    assert.ok(created.body.affected_cis.some((x: any) => x.ref === app));
    assert.equal(await find(key), undefined, 'handled');
    assert.equal((await analyst.post('/api/candidates/create', { key })).status, 404, 'a handled candidate is gone');

    // Dismissed: gone for good (its one incident is the evidence).
    const other = await incident({ title: 'Mail down', impact: 1, urgency: 1 });
    ok(await pm.post(`/api/incidents/${other}/major`, {}));
    await resolve(other);
    ok(await analyst.post('/api/candidates/dismiss', { key: `major_without_problem:incident:${other}`, reason: 'Vendor outage, covered by the supplier review' }));
    assert.equal(await find(`major_without_problem:incident:${other}`), undefined);
  });

  test('same category and resolution: workarounds that keep being applied', async () => {
    const cat = (await pm.post('/api/categories', { name: `Printing ${++n}` })).body.id;
    const other = (await pm.post('/api/categories', { name: `Mail ${++n}` })).body.id;
    for (let i = 0; i < 4; i++) await resolve(await incident({ category_id: cat }), 'workaround');
    for (let i = 0; i < 3; i++) await resolve(await incident({ category_id: other }), 'workaround');
    for (let i = 0; i < 4; i++) await resolve(await incident({ category_id: other }), 'cancelled').catch(() => {});
    const key = `recurring_resolution:category:${cat}:workaround`;
    const c = await find(key);
    assert.match(c.reason, /^4 incidents in Printing \d+ resolved with a workaround in 30 days, none linked to a problem: the same workaround keeps being applied$/);
    assert.equal(await find(`recurring_resolution:category:${other}:workaround`), undefined, 'three is below the threshold');
    assert.equal(await find(`recurring_resolution:category:${other}:cancelled`), undefined, 'cancelled incidents never count');
    ok(await analyst.post('/api/candidates/dismiss', { key, reason: 'Printer fleet is being replaced' }));
    assert.equal(await find(key), undefined);
  });

  test('reported candidates: idempotent per reporter, secrets redacted, evidence capped, and logged with their evidence', async () => {
    await admin.post('/api/users', { username: 'logbot', display_name: 'Log analysis', role: 'integration', password: 'seven amber reading lamps' });
    const bot = new Client(k.base);
    await bot.post('/api/auth/login', { username: 'logbot', password: 'seven amber reading lamps' });
    const ingest = new Client(k.base, (await bot.post('/api/tokens', { name: 'logs', scopes: ['ingest'] })).body.token);
    const app = await ci('ledger');
    const inc = await incident({ title: 'Ledger export failed', cis: [app] });
    const report = {
      source: 'log-agent', external_key: 'ledger-oom-1', title: 'Ledger runs out of memory nightly', reason: 'OOM kills at 02:00 for 5 nights, growing heap',
      ci_ref: app,
      evidence: {
        incident_refs: [inc.toLowerCase()],
        items: [{ reference: 'kubectl logs ledger-7f9', summary: 'java.lang.OutOfMemoryError password=Hunter2Secret!', occurred_at: new Date().toISOString(), url: 'https://grafana.example.com/d/ledger' }],
        notes: 'Heap grows 200 MB per day since the 4.2 upgrade.',
      },
    };
    const first = await ingest.post('/api/candidates/report', report);
    ok(first, 201);
    assert.equal(first.body.created, true);
    assert.match(first.body.key, /^reported:\d+$/);
    const again = await ingest.post('/api/candidates/report', { ...report, reason: 'OOM kills at 02:00 for 6 nights, growing heap' });
    ok(again, 200);
    assert.equal(again.body.key, first.body.key, 'the same finding updates, not duplicates');
    assert.equal((await analyst.post('/api/candidates/report', report)).status, 409, 'someone else cannot overwrite it');
    assert.equal((await ingest.post('/api/candidates/report', { ...report, external_key: 'big', evidence: { notes: 'x'.repeat(9000), items: Array.from({ length: 200 }, (_, i) => ({ reference: `r${i}`, summary: 'y'.repeat(400) })) } })).status, 400, 'evidence over 64 KB is refused');
    assert.equal((await ingest.post('/api/candidates/report', { ...report, external_key: 'js', evidence: { items: [{ reference: 'x', url: 'javascript:alert(1)' }] } })).status, 400, 'only http(s) links');
    assert.equal((await ingest.get('/api/candidates')).status, 403, 'an ingest token reports, it does not read');

    const c = await find(first.body.key);
    assert.equal(c.rule, 'reported');
    assert.equal(c.source, 'log-agent');
    assert.equal(c.reason, 'OOM kills at 02:00 for 6 nights, growing heap');
    assert.equal(c.evidence.notes, report.evidence.notes);
    const item = c.evidence.records.find((r: any) => r.kind === 'external' && r.url);
    assert.doesNotMatch(item.summary, /Hunter2Secret/, 'secrets are redacted');
    assert.ok(c.evidence.records.some((r: any) => r.incident_ref === inc), 'Kernel incidents named in the evidence');

    const created = await analyst.post('/api/candidates/create', { key: c.key });
    ok(created, 201);
    assert.equal(created.body.title, 'Ledger runs out of memory nightly');
    assert.match(created.body.description, /Heap grows 200 MB per day/);
    assert.match(created.body.description, /https:\/\/grafana\.example\.com\/d\/ledger/);
    assert.ok(created.body.incidents.some((i: any) => i.ref === inc));
    assert.equal(await find(c.key), undefined, 'handled');
    const { rows } = await ownerQuery('SELECT problem_ref FROM reported_candidates WHERE id = $1', [Number(c.key.slice(9))]);
    assert.equal(rows[0].problem_ref, created.body.ref);

    // Negative: a report that names nothing visible still shows (its own finding), and a dismissed one stays away when re-reported.
    const lone = (await ingest.post('/api/candidates/report', { source: 'log-agent', external_key: 'disk-1', title: 'Disk fills on backup host', reason: 'Disk 92% and growing' })).body.key;
    assert.ok(await find(lone));
    ok(await analyst.post('/api/candidates/dismiss', { key: lone, reason: 'Backup host is being retired' }));
    ok(await ingest.post('/api/candidates/report', { source: 'log-agent', external_key: 'disk-1', title: 'Disk fills on backup host', reason: 'Disk 95% and growing' }));
    assert.equal(await find(lone), undefined, 'a dismissed report stays dismissed');
  });

  test('a candidate only counts records its reader can see (row-level security)', async () => {
    const app = await ci('payroll');
    const refs = [];
    for (let i = 0; i < 3; i++) refs.push(await incident({ cis: [app] }, pm));
    ok(await pm.put(`/api/records/${refs[0]}/visibility`, { restricted: true, reason: 'HR investigation' }));
    const key = `recurring_records:ci:${app}`;
    assert.equal((await find(key, pm)).count, 3, 'the creator sees all three');
    assert.equal(await find(key, analyst), undefined, 'two visible incidents are below the threshold');
  });

  test('MCP: list with reason and evidence, report, dismiss and log by key', async () => {
    const mcp = new McpClient({ name: 'cand', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const call = async (name: string, args: object) => {
      const res = (await mcp.callTool({ name, arguments: args })) as any;
      assert.ok(!res.isError, res.content[0].text);
      return JSON.parse(res.content[0].text);
    };
    const reported = await call('report_problem_candidate', { source: 'agent', external_key: 'queue-lag', title: 'Order queue lag grows every evening', reason: 'Consumer lag doubles at 18:00 for a week' });
    const listed = await call('list_problem_candidates', { rule: 'reported' });
    const c = listed.candidates.find((x: any) => x.key === reported.key);
    assert.equal(c.reason, 'Consumer lag doubles at 18:00 for a week');
    assert.ok(Array.isArray(c.evidence.records));
    const problem = await call('create_problem_from_candidate', { key: reported.key });
    assert.match(problem.ref, /^PRB/);
    const other = await call('report_problem_candidate', { source: 'agent', external_key: 'cert', title: 'Certificates expire unnoticed', reason: 'Two certificates expired last month' });
    await call('dismiss_problem_candidate', { key: other.key, reason: 'Covered by the certificate change' });
    assert.equal((await call('list_problem_candidates', {})).candidates.some((x: any) => x.key === other.key), false);
    await mcp.close();
  });

  test('a disabled rule finds nothing', async () => {
    const app = await ci('wiki');
    for (let i = 0; i < 3; i++) await incident({ cis: [app] });
    const key = `recurring_records:ci:${app}`;
    assert.ok(await find(key));
    await setRule('recurring_records', { enabled: false });
    assert.equal(await find(key), undefined);
    assert.equal((await list()).rules.find((r: any) => r.rule === 'recurring_records').enabled, false);
    await setRule('recurring_records', { enabled: true });
  });
});
