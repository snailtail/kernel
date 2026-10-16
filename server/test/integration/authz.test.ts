// Authorisation matrix: every role against every kind of endpoint, asserting both allowed and denied cases.
// The expectations are written out here, independently of policy.ts, so the test checks the policy.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, skip, startKernel, USERS, type Harness } from './harness.js';

type RoleName = 'admin' | 'pm' | 'analyst' | 'viewer' | 'integration';
const ALL: RoleName[] = ['admin', 'pm', 'analyst', 'viewer', 'integration'];
const READERS: RoleName[] = ['admin', 'pm', 'analyst', 'viewer'];
const WORKERS: RoleName[] = ['admin', 'pm', 'analyst'];
const MANAGERS: RoleName[] = ['admin', 'pm'];
const ADMINS: RoleName[] = ['admin'];

// [method, path, body, allowed roles]
const MATRIX: [string, string, unknown, RoleName[]][] = [
  ['GET', '/api/meta', undefined, ALL],
  ['GET', '/api/problems', undefined, READERS],
  ['GET', '/api/problems/PRB000001', undefined, READERS],
  ['GET', '/api/problems/PRB000001/export.md', undefined, READERS],
  ['GET', '/api/problems/similar?text=database%20timeout', undefined, READERS],
  ['GET', '/api/dashboard', undefined, READERS],
  ['GET', '/api/kedb', undefined, READERS],
  ['GET', '/api/actions', undefined, READERS],
  ['GET', '/api/reports', undefined, READERS],
  ['GET', '/api/review', undefined, READERS],
  ['GET', '/api/candidates', undefined, READERS],
  ['GET', '/api/systems', undefined, READERS],
  ['POST', '/api/problems', { title: 'Matrix' }, WORKERS],
  ['PATCH', '/api/problems/PRB000001', { impact: 2 }, WORKERS],
  ['POST', '/api/problems/PRB000001/transition', { to: 'analysis' }, WORKERS],
  ['POST', '/api/problems/PRB000001/comments', { body: 'note' }, WORKERS],
  ['POST', '/api/problems/PRB000001/links', { kind: 'incident', reference: 'INC-M' }, WORKERS],
  ['PUT', '/api/problems/PRB000001/assessment', { ec_risk: 'x' }, WORKERS],
  ['POST', '/api/problems/PRB000001/actions', { title: 'Do it' }, WORKERS],
  ['POST', '/api/problems/PRB000001/analyses', { technique: 'five_whys' }, WORKERS],
  ['PUT', '/api/problems/PRB000001/watch', {}, READERS],
  ['POST', '/api/candidates/dismiss', { key: 'recurring_records:ci:CI999999', reason: 'Matrix check' }, WORKERS],
  ['POST', '/api/integrations/records', { records: [{ system: 'S', kind: 'event', reference: 'E-1' }] }, ['admin', 'pm', 'analyst', 'integration']],
  ['POST', '/api/candidates/report', { source: 'matrix', external_key: 'k1', title: 'Matrix finding', reason: 'Seen in the logs' }, ['admin', 'pm', 'analyst', 'integration']],
  ['POST', '/api/problems/PRB000002/duplicate', { of: 'PRB000001' }, MANAGERS],
  ['PUT', '/api/candidates/rules/recurring_records', { settings: { min_records: 5, window_days: 7 } }, MANAGERS],
  ['POST', '/api/categories', { name: `Cat-${Math.random()}` }, MANAGERS],
  ['POST', '/api/systems', { name: `Sys-${Math.random()}` }, MANAGERS],
  ['GET', '/api/admin/backups', undefined, MANAGERS],
  ['GET', '/api/cis', undefined, READERS],
  ['GET', '/api/ci-types', undefined, READERS],
  ['GET', '/api/ci-groups', undefined, READERS],
  ['GET', '/api/incidents', undefined, READERS],
  ['GET', '/api/reviews', undefined, READERS],
  ['GET', '/api/records/PRB000001/history', undefined, READERS],
  ['POST', '/api/records/PRB000001/comments', { body: 'note' }, WORKERS],
  ['GET', '/api/changes', undefined, READERS],
  ['POST', '/api/changes', { title: 'authz' }, ['admin', 'pm', 'analyst']],
  ['POST', '/api/change-freezes', { name: 'f', starts_at: '2030-01-01T00:00:00Z', ends_at: '2030-01-02T00:00:00Z' }, MANAGERS],
  ['POST', '/api/incidents', { title: 'authz' }, ['admin', 'pm', 'analyst']],
  ['POST', '/api/ci-groups', { name: `g-${Math.random()}` }, MANAGERS],
  ['GET', '/api/ci-relationship-types', undefined, READERS],
  ['POST', '/api/cis', { name: `ci-${Math.random()}`, ci_type: 'other' }, MANAGERS],
  ['POST', '/api/cis/upsert', { items: [{ source_system: 'T', source_id: `t-${Math.random()}`, name: 'x', ci_type: 'other' }] }, ['admin', 'pm', 'integration']],
  ['GET', '/api/people', undefined, READERS],
  ['POST', '/api/people', { name: `p-${Math.random()}` }, ['admin', 'pm', 'analyst']],
  ['GET', '/api/organisations', undefined, READERS],
  ['POST', '/api/organisations', { name: `o-${Math.random()}` }, MANAGERS],
  ['GET', '/api/users', undefined, ADMINS],
  ['POST', '/api/users', { username: `u${Date.now()}`, display_name: 'Matrix User', role: 'viewer', password: 'a long matrix passphrase' }, ADMINS],
  ['GET', '/api/webhooks', undefined, ADMINS],
  ['GET', '/api/audit', undefined, ADMINS],
  ['GET', '/api/audit/verify', undefined, ADMINS],
  ['GET', '/api/admin/security', undefined, ADMINS],
  ['GET', '/api/admin/security-alerting', undefined, ADMINS],
  ['GET', '/api/admin/privacy', undefined, ADMINS],
  ['GET', '/api/admin/mfa-policy', undefined, ADMINS],
];

describe('authorisation', { skip }, () => {
  let k: Harness;
  const clients = {} as Record<RoleName, Client>;

  before(async () => {
    k = await startKernel();
    for (const r of ALL) clients[r] = await k.login(r as keyof typeof USERS);
    // Fixtures: two problems to act on.
    await clients.analyst.post('/api/problems', { title: 'Fixture one' });
    await clients.analyst.post('/api/problems', { title: 'Fixture two' });
  });
  after(() => k?.close());

  for (const [method, path, body, allowed] of MATRIX) {
    test(`${method} ${path}`, async () => {
      for (const role of ALL) {
        const res = await clients[role].request(method, path, body);
        if (allowed.includes(role)) assert.notEqual(res.status, 403, `${role} should be allowed (${res.status} ${JSON.stringify(res.body)?.slice(0, 120)})`);
        else assert.equal(res.status, 403, `${role} should be denied, got ${res.status}`);
      }
    });
  }

  test('MCP lists only the tools a role may use', async () => {
    const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const tools = async (role: RoleName) => {
      const token = (await clients[role === 'integration' ? 'admin' : role].post('/api/tokens', { name: 'mcp', scopes: ['read', 'write', 'mcp'] })).body.token;
      const c = new McpClient({ name: 'authz', version: '1' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      const names = (await c.listTools()).tools.map((t) => t.name);
      await c.close();
      return names;
    };
    const viewer = await tools('viewer');
    assert.ok(viewer.includes('get_problem') && !viewer.includes('update_problem'));
    const analyst = await tools('analyst');
    assert.ok(analyst.includes('update_problem') && !analyst.includes('mark_duplicate') && !analyst.includes('query_audit_log'));
    const pm = await tools('pm');
    assert.ok(pm.includes('mark_duplicate') && !pm.includes('query_audit_log'));
    assert.ok((await tools('admin')).includes('query_audit_log'));
  });

  test('clients cannot assign server-controlled fields (mass assignment)', async () => {
    const res = await clients.analyst.post('/api/problems', { title: 'Mass', status: 'closed', ref: 'PRB777777', created_by: 1, id: 5000, priority: 1, closed_at: '2020-01-01' });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'new');
    assert.notEqual(res.body.ref, 'PRB777777');
    assert.equal(res.body.created_by_name, 'Analyst');
    assert.equal(res.body.priority, 5, 'priority follows impact and urgency');
    assert.equal(res.body.closed_at, null);
    const me = (await clients.analyst.get('/api/auth/me')).body;
    assert.equal((await clients.analyst.put('/api/auth/preferences', { theme: 'dark', role: 'admin' })).status, 400, 'unknown keys rejected');
    assert.equal((await clients.analyst.patch(`/api/users/${me.id}`, { role: 'admin' })).status, 403, 'no self-promotion');
  });

  test("no access to other users' tokens or sessions (IDOR)", async () => {
    const token = (await clients.pm.post('/api/tokens', { name: 'pm-only' })).body;
    assert.equal((await clients.analyst.del(`/api/tokens/${token.id}`)).status, 404);
    assert.ok(!(await clients.analyst.get('/api/tokens')).body.some((t: any) => t.id === token.id));
    const pmSession = (await clients.pm.get('/api/auth/sessions')).body[0];
    assert.equal((await clients.analyst.del(`/api/auth/sessions/${pmSession.id}`)).status, 404);
    assert.equal((await clients.pm.get('/api/auth/me')).status, 200);
  });
});
