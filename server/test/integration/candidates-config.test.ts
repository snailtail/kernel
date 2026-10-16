// Configuration risk as problem candidates (part 3 of #31): CIs that keep going missing, end-of-life versions from the
// editable table, and single points of failure, each with a positive, a negative and a dismissed case; the EOL table's
// API; and the rules in the process map.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, ownerQuery, skip, startKernel, type Harness } from './harness.js';

const ok = (r: { status: number; body: unknown }, status?: number) =>
  assert.ok(status ? r.status === status : r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);

describe('configuration risk candidates (#31)', { skip }, () => {
  let k: Harness;
  let pm: Client, analyst: Client;
  let n = 0;

  before(async () => {
    k = await startKernel();
    [pm, analyst] = await Promise.all([k.login('pm'), k.login('analyst')]);
  });
  after(() => k?.close());

  const ci = async (name: string, ci_type = 'application', extra: object = {}) => (await pm.post('/api/cis', { name: `${name}-${++n}`, ci_type, ...extra })).body.ref as string;
  const candidates = async (rule: string, q = '') => (await analyst.get(`/api/candidates?rule=${rule}${q}`)).body.candidates as any[];
  const find = async (key: string) => (await analyst.get('/api/candidates')).body.candidates.find((c: any) => c.key === key);
  const dismiss = async (key: string) => ok(await analyst.post('/api/candidates/dismiss', { key, reason: 'Accepted risk for now' }));
  const rel = async (from: string, type: string, target: string) => ok(await pm.post(`/api/cis/${from}/relationships`, { type, target }));

  test('CIs that keep going missing in sync; once is not enough; a dismissal holds for one more', async () => {
    const hosts = Array.from({ length: 12 }, (_, i) => ({ source_id: `inv-${i}`, name: `inv-host-${i}`, ci_type: 'other' }));
    const push = (cis: object[]) => pm.post('/api/cmdb/ci-batch', { source_system: 'Inventory', cis, full_sync: true });
    const without = (...ids: number[]) => hosts.filter((_, i) => !ids.includes(i));
    ok(await push(hosts));
    // inv-11 goes missing twice; inv-10 once.
    for (let r = 0; r < 3; r++) ok(await push(without(10, 11)));
    ok(await push(without(10)));
    for (let r = 0; r < 3; r++) ok(await push(without(10, 11)));
    const flaky = (await analyst.get('/api/cis?q=inv-host-11&status=all')).body[0].ref;
    const once = (await analyst.get('/api/cis?q=inv-host-10&status=all')).body[0].ref;
    const c = await find(`repeatedly_missing:ci:${flaky}`);
    assert.match(c.reason, new RegExp(`^inv-host-11 \\(${flaky}\\) was reported missing 2 times in 90 days and is missing now$`));
    assert.equal(c.proactive, true);
    assert.ok(c.evidence.records.every((r: any) => r.kind === 'sync' && /Not reported by Inventory/.test(r.summary)));
    assert.equal(await find(`repeatedly_missing:ci:${once}`), undefined, 'missing once');

    await dismiss(c.key);
    ok(await push(hosts));
    for (let r = 0; r < 3; r++) ok(await push(without(11)));
    assert.equal(await find(c.key), undefined, 'one more time is not two new ones');
  });

  test('versions at end of life, from the editable table; not other versions; a new CI on the version brings it back', async () => {
    const old = await ci('legacy-web', 'virtual_machine', { attributes: { os: 'Ubuntu 20.04.6 LTS' } });
    const db = await ci('reporting-db', 'database', { attributes: { engine: 'PostgreSQL', version: '13.4' } });
    await ci('modern-db', 'database', { attributes: { engine: 'PostgreSQL', version: '16.2' } });
    await ci('decoy-db', 'database', { attributes: { engine: 'PostgreSQL', version: '130' } });
    const ubuntu = (await candidates('eol_versions')).find((c) => c.subject.name === 'Ubuntu 20.04');
    assert.equal(ubuntu.reason, '1 CI runs Ubuntu 20.04, which reached end of life on 2025-05-31: no more security fixes');
    assert.deepEqual(ubuntu.evidence.cis.map((x: any) => x.ref), [old]);
    const pg = (await candidates('eol_versions')).find((c) => c.subject.name === 'PostgreSQL 13');
    assert.deepEqual(pg.evidence.records.map((r: any) => r.reference), [db], 'the decoy (130) and 16 do not match');

    // Near: a row reached within warn_days counts; one further away does not.
    const soon = new Date(Date.now() + 100 * 86_400_000).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    assert.equal((await analyst.post('/api/candidates/eol', { product: 'Ubuntu', version: '22.04', eol_date: soon })).status, 403, 'problem managers keep the table');
    ok(await pm.post('/api/candidates/eol', { product: 'Ubuntu', version: '22.04', eol_date: soon, note: 'Test row' }), 201);
    assert.equal((await pm.post('/api/candidates/eol', { product: 'ubuntu', version: '22.04', eol_date: soon })).status, 409, 'one row per product and version');
    const far = (await pm.post('/api/candidates/eol', { product: 'Debian', version: '12', eol_date: later })).body;
    await ci('new-web', 'virtual_machine', { attributes: { os: 'Ubuntu 22.04' } });
    await ci('deb-web', 'virtual_machine', { attributes: { os: 'Debian 12' } });
    const near = (await candidates('eol_versions')).find((c) => c.subject.name === 'Ubuntu 22.04');
    assert.match(near.reason, new RegExp(`^1 CI runs Ubuntu 22.04, which reaches end of life on ${soon}$`));
    assert.equal((await candidates('eol_versions')).some((c) => c.subject.name === 'Debian 12'), false, 'more than 180 days away');
    ok(await pm.put(`/api/candidates/eol/${far.id}`, { product: 'Debian', version: '12', eol_date: soon }));
    assert.ok((await candidates('eol_versions')).some((c) => c.subject.name === 'Debian 12'), 'moved closer');
    ok(await pm.del(`/api/candidates/eol/${far.id}`));
    assert.equal((await analyst.get('/api/candidates/eol')).body.some((r: any) => r.id === far.id), false);
    const { rows } = await ownerQuery("SELECT action FROM audit_log WHERE entity_ref = $1 ORDER BY id", [`eol:${far.id}`]);
    assert.deepEqual(rows.map((r: any) => r.action), ['create', 'update', 'delete']);

    await dismiss(ubuntu.key);
    assert.equal(await find(ubuntu.key), undefined);
    const another = await ci('legacy-api', 'virtual_machine', { attributes: { os: 'Ubuntu 20.04' } });
    assert.deepEqual((await find(ubuntu.key)).evidence.records.map((r: any) => r.reference), [another], 'back with the new CI only');
  });

  test('single points of failure: many services on one CI without an alternative; not when redundant', async () => {
    const services = [];
    for (let i = 0; i < 3; i++) services.push(await ci(`svc`, 'business_service'));
    const sole = await ci('core-db', 'database'), primary = await ci('ha-db-a', 'database'), replica = await ci('ha-db-b', 'database');
    const cluster = await ci('cluster-db', 'database', { tags: ['redundant'] });
    // Per service: one app on core-db alone, one on a pair of databases, one on a database marked redundant.
    for (const [i, svc] of services.entries()) {
      const [single, paired, clustered] = [await ci(`app${i}`), await ci(`ha-app${i}`), await ci(`cl-app${i}`)];
      for (const app of [single, paired, clustered]) await rel(app, 'member_of', svc);
      await rel(single, 'uses_database', sole);
      await rel(paired, 'uses_database', primary);
      await rel(paired, 'uses_database', replica);
      await rel(clustered, 'uses_database', cluster);
    }
    const c = await find(`single_point_of_failure:ci:${sole}`);
    assert.ok(c, 'found');
    assert.match(c.reason, new RegExp(`^3 services depend on core-db-\\d+ \\(${sole}\\), and something relies on it with no alternative`));
    assert.deepEqual(c.evidence.records.map((r: any) => r.reference).sort(), [...services].sort());
    for (const ref of [primary, replica]) assert.equal(await find(`single_point_of_failure:ci:${ref}`), undefined, 'two databases of the same type: redundant');
    assert.equal(await find(`single_point_of_failure:ci:${cluster}`), undefined, 'tagged redundant');
    ok(await pm.put('/api/candidates/rules/single_point_of_failure', { settings: { min_services: 4 } }));
    assert.equal(await find(c.key), undefined, 'three services are below four');
    ok(await pm.put('/api/candidates/rules/single_point_of_failure', { settings: { min_services: 3 } }));

    // Logging or linking it puts the CI and its services on the problem.
    const prb = (await analyst.post('/api/problems', { title: 'core-db has no failover' })).body.ref;
    const linked = await analyst.post('/api/candidates/link', { ref: prb, key: c.key });
    ok(linked);
    assert.ok(linked.body.affected_cis.some((x: any) => x.ref === sole));

    await dismiss(c.key);
    assert.equal(await find(c.key), undefined);
  });

  test('single points of failure through a diamond: each service counted once; the redundant middle is not one', async () => {
    // Three services, each with an app that relies on two middle tiers of the same type, which both use one database.
    const db = await ci('diamond-db', 'database'), left = await ci('mid-left'), right = await ci('mid-right');
    await rel(left, 'uses_database', db);
    await rel(right, 'uses_database', db);
    const services = [];
    for (let i = 0; i < 3; i++) {
      const svc = await ci('diamond-svc', 'business_service'), app = await ci(`diamond-app${i}`);
      await rel(app, 'member_of', svc);
      await rel(app, 'depends_on', left);
      await rel(app, 'depends_on', right);
      services.push(svc);
    }
    const c = await find(`single_point_of_failure:ci:${db}`);
    assert.deepEqual(c.evidence.records.map((r: any) => r.reference).sort(), [...services].sort(), 'each service once, though two paths reach the database');
    assert.match(c.reason, /^3 services depend on/);
    for (const mid of [left, right]) assert.equal(await find(`single_point_of_failure:ci:${mid}`), undefined, 'two of the same type side by side');
  });

  test('a rule that cannot run is reported, and the other rules are still listed', async () => {
    const before = (await analyst.get('/api/candidates')).body;
    const other = before.candidates.find((c: any) => c.rule === 'single_point_of_failure');
    const eol = before.candidates.find((c: any) => c.rule === 'eol_versions');
    assert.ok(other && eol);
    await ownerQuery('ALTER TABLE eol_versions RENAME TO eol_versions_away');
    try {
      const res = await analyst.get('/api/candidates');
      ok(res);
      assert.equal(res.body.rules.find((r: any) => r.rule === 'eol_versions').error, 'This rule could not run');
      assert.equal(res.body.rules.find((r: any) => r.rule === 'single_point_of_failure').error, undefined);
      assert.ok(res.body.candidates.some((c: any) => c.key === other.key), 'the other rules still list theirs');
      assert.equal(res.body.candidates.some((c: any) => c.rule === 'eol_versions'), false);
      assert.equal((await analyst.get(`/api/candidates/draft?key=${encodeURIComponent(eol.key)}`)).status, 503);
      ok(await analyst.get('/api/flow')); // the process map too
    } finally {
      await ownerQuery('ALTER TABLE eol_versions_away RENAME TO eol_versions');
    }
  });

  test('every rule shows in the process map, with its open candidates', async () => {
    const map = (await analyst.get('/api/flow')).body;
    const problem = map.nodes.find((x: any) => x.id === 'problem');
    const rules = (await analyst.get('/api/candidates')).body.rules;
    assert.deepEqual(problem.found_by.map((r: any) => r.rule), rules.filter((r: any) => r.enabled).map((r: any) => r.rule));
    assert.ok(problem.found_by.find((r: any) => r.rule === 'eol_versions').count >= 1);
    assert.equal(problem.found_by.find((r: any) => r.rule === 'major_without_problem').proactive, false);
    assert.equal(problem.found_by.find((r: any) => r.rule === 'single_point_of_failure').proactive, true);
    assert.ok(map.nodes.find((x: any) => x.id === 'change').hands_over.some((h: any) => h.to === 'problem'));
  });
});
