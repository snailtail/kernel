// The read-only reporting schema for BI tools (#150): the kernel_reporting role reads the views and nothing else, the
// views carry no free text or personal data, and restricted records are not in them, whatever the reader sets.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { ownerQuery, skip, startKernel, TEST_DATABASE_URL, type Harness } from './harness.js';

const ROLE = 'kernel_test_reporting';
const PASSWORD = 'reporting role password for tests only';

/**
 * Every column of every view. A new column needs a decision: no titles, descriptions, notes, names of people, email
 * addresses or user ids. Names of categories, teams, SLAs and CIs are allowed.
 */
const ALLOWED: Record<string, string[]> = {
  incidents: [
    'ref', 'status', 'priority', 'impact', 'urgency', 'category_id', 'category', 'team_id', 'team', 'source', 'is_major',
    'resolution_code', 'classification', 'reopen_count', 'problem_ref', 'parent_ref', 'sla', 'created_at', 'responded_at',
    'resolved_at', 'closed_at', 'major_declared_at', 'response_due_at', 'response_breached_at', 'resolution_due_at',
    'resolution_breached_at', 'response_sla_met', 'resolution_sla_met', 'sla_paused_minutes', 'minutes_to_respond',
    'minutes_to_resolve',
  ],
  problems: [
    'ref', 'status', 'priority', 'impact', 'urgency', 'category_id', 'category', 'team_id', 'team', 'detection', 'is_major',
    'closure_code', 'classification', 'has_workaround', 'workaround_effectiveness', 'ec_risk_level', 'created_at',
    'known_error_at', 'resolved_at', 'closed_at', 'minutes_to_resolve',
  ],
  changes: [
    'ref', 'change_type', 'status', 'risk', 'outcome', 'source', 'team_id', 'team', 'classification', 'problem_ref',
    'planned_start', 'planned_end', 'actual_start', 'actual_end', 'created_at', 'closed_at', 'minutes_to_implement',
  ],
  sla_events: ['incident_ref', 'target', 'kind', 'fired_at'],
  cis: ['ref', 'class', 'name', 'ci_type', 'status', 'environment', 'criticality', 'in_catalogue', 'sla', 'availability_target', 'created_at', 'missing_since'],
  ci_relationships: ['from_ref', 'type', 'to_ref'],
  record_cis: ['record_type', 'record_ref', 'ci_ref'],
};

describe('reporting schema for BI tools (#150)', { skip }, () => {
  let k: Harness;
  let bi: pg.Client;
  const refs: Record<string, string> = {};

  before(async () => {
    process.env.KERNEL_REPORTING_DB_USER = ROLE;
    process.env.KERNEL_REPORTING_DB_PASSWORD = PASSWORD;
    k = await startKernel();
    const [analyst, pm] = await Promise.all([k.login('analyst'), k.login('pm')]);
    const ci = (await pm.post('/api/cis', { name: 'db01', ci_type: 'virtual_machine' })).body.ref;
    for (const [key, path, body] of [
      ['openIncident', '/api/incidents', { title: 'Payroll slow for Anna Andersson', description: 'anna@example.com', cis: [ci] }],
      ['secretIncident', '/api/incidents', { title: 'Breach', description: 'indicators', cis: [ci] }],
      ['openProblem', '/api/problems', { title: 'Slow disk' }],
      ['secretProblem', '/api/problems', { title: 'Credential leak' }],
      ['openChange', '/api/changes', { title: 'Replace disk', cis: [ci] }],
      ['secretChange', '/api/changes', { title: 'Rotate keys', cis: [ci] }],
    ] as const) {
      const r = await analyst.post(path, body);
      assert.ok(r.status === 201 || r.status === 200, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
      refs[key] = r.body.ref;
    }
    for (const ref of [refs.secretIncident, refs.secretProblem, refs.secretChange]) {
      const r = await analyst.put(`/api/records/${ref}/visibility`, { restricted: true, reason: 'Security investigation' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    // An open incident caused by the restricted problem, another by the open one; SLA events on both incidents.
    await ownerQuery('UPDATE incidents SET problem_id = (SELECT id FROM problems WHERE ref = $1) WHERE ref = $2', [refs.secretProblem, refs.openIncident]);
    await ownerQuery('UPDATE changes SET problem_id = (SELECT id FROM problems WHERE ref = $1) WHERE ref = $2', [refs.openProblem, refs.openChange]);
    await ownerQuery("INSERT INTO sla_events (incident_id, target, kind) SELECT id, 'response', 'breach' FROM incidents WHERE ref = ANY($1)", [[refs.openIncident, refs.secretIncident]]);

    const url = new URL(TEST_DATABASE_URL!);
    url.username = ROLE;
    url.password = PASSWORD;
    bi = new pg.Client({ connectionString: url.toString() });
    await bi.connect();
  });
  after(async () => {
    await bi?.end();
    await k?.close();
    delete process.env.KERNEL_REPORTING_DB_USER;
    delete process.env.KERNEL_REPORTING_DB_PASSWORD;
  });

  test('every column is on the allowlist, and every allowed view exists', async () => {
    const { rows } = await bi.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'reporting' ORDER BY table_name, ordinal_position");
    const actual: Record<string, string[]> = {};
    for (const r of rows) (actual[r.table_name] ??= []).push(r.column_name);
    assert.deepEqual(actual, ALLOWED);
  });

  test('the role reads the views, with unrestricted records only', async () => {
    const all = async (sql: string) => (await bi.query(sql)).rows;
    const incidents = await all('SELECT ref, problem_ref FROM reporting.incidents');
    assert.deepEqual(incidents.map((r) => r.ref), [refs.openIncident]);
    assert.equal(incidents[0].problem_ref, null, 'the ref of a restricted problem is not shown');
    assert.deepEqual((await all('SELECT ref FROM reporting.problems')).map((r) => r.ref), [refs.openProblem]);
    const changes = await all('SELECT ref, problem_ref FROM reporting.changes');
    assert.deepEqual(changes, [{ ref: refs.openChange, problem_ref: refs.openProblem }]);
    assert.deepEqual((await all('SELECT incident_ref FROM reporting.sla_events')).map((r) => r.incident_ref), [refs.openIncident]);
    assert.deepEqual(
      (await all('SELECT record_ref FROM reporting.record_cis ORDER BY record_ref')).map((r) => r.record_ref),
      [refs.openChange, refs.openIncident].sort(),
    );
    assert.equal((await all("SELECT count(*)::int AS n FROM reporting.cis WHERE name = 'db01'"))[0].n, 1);
    await all('SELECT * FROM reporting.ci_relationships');
  });

  test('setting a viewer does not reveal restricted records', async () => {
    await bi.query("SELECT set_config('kernel.viewer', 'system', false)");
    try {
      const { rows } = await bi.query('SELECT ref FROM reporting.incidents UNION ALL SELECT ref FROM reporting.problems UNION ALL SELECT ref FROM reporting.changes');
      for (const ref of [refs.secretIncident, refs.secretProblem, refs.secretChange]) assert.ok(!rows.some((r) => r.ref === ref), ref);
    } finally {
      await bi.query("SELECT set_config('kernel.viewer', '', false)");
    }
  });

  test('the role cannot read or call anything in public, or change anything', async () => {
    for (const sql of [
      'SELECT * FROM public.incidents',
      'SELECT * FROM public.users',
      'SELECT * FROM public.audit_log',
      "SELECT public.kernel_ref_hidden('INC000001')",
      "INSERT INTO reporting.cis (ref) VALUES ('x')",
      'CREATE VIEW reporting.sneaky AS SELECT 1',
      'CREATE TABLE public.sneaky (id int)',
    ]) {
      await assert.rejects(bi.query(sql), /permission denied|cannot insert|read-only transaction/, sql);
    }
    const { rows } = await ownerQuery(
      "SELECT count(*)::int AS n FROM pg_default_acl d, aclexplode(d.defaclacl) a WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)",
      [ROLE],
    );
    assert.equal(rows[0].n, 0, 'no default privileges hand it new tables');
  });

  test('the security status shows the role as read-only', async () => {
    const admin = await k.login('admin');
    const check = (await admin.get('/api/admin/security')).body.checks.find((c: any) => c.id === 'reporting_role');
    assert.equal(check.ok, true, check.detail);
    assert.match(check.detail, /reads the reporting views only/);
  });
});
