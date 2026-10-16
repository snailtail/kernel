import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client, ownerQuery, skip, startKernel, type Harness } from './harness.js';

describe('security events (#64)', { skip }, () => {
  let k: Harness;
  let admin: Client, analyst: Client;
  let flush: () => Promise<void>;

  const events = async (q: string) => {
    await flush();
    const res = await admin.get(`/api/security-events?${q}`);
    assert.equal(res.status, 200);
    return res.body as any[];
  };

  // Some events follow a background audit write (a lock-out); wait until one matches.
  const eventually = async (q: string, match: (e: any) => boolean) => {
    for (let i = 0; i < 40; i++) {
      const found = (await events(q)).find(match);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  };

  before(async () => {
    k = await startKernel();
    [admin, analyst] = await Promise.all([k.login('admin'), k.login('analyst')]);
    ({ flushSecurityEvents: flush } = await import('../../src/security-events.js'));
  });
  after(() => k?.close());

  test('failed sign-ins: the account when it exists, only a digest when it does not', async () => {
    const anon = new Client(k.base);
    assert.equal((await anon.post('/api/auth/login', { username: 'analyst', password: 'wrong password' })).status, 401);
    assert.equal((await anon.post('/api/auth/login', { username: 'Typed-My-Passw0rd-Here', password: 'x' })).status, 401);
    const failed = await events('action=auth.login_failed');
    const known = failed.find((e) => e.username === 'analyst');
    assert.ok(known, 'the failure is tied to the account');
    assert.equal(known.outcome, 'failure');
    assert.equal(known.severity, 'warning');
    assert.equal(known.detail.reason, 'password');
    assert.ok(known.ip, 'with the client address');
    const unknown = failed.find((e) => e.user_id === null);
    assert.ok(unknown, 'an unknown name is recorded too');
    assert.notEqual(unknown.account, '');
    const { rows } = await ownerQuery("SELECT count(*)::int AS n FROM security_events WHERE (account || detail::text || message || target) ILIKE '%typed-my-passw0rd%'");
    assert.equal(rows[0].n, 0, 'a mistyped name (often a password) is never stored as typed');
  });

  test('sign-ins, lock-outs and a new administrator come from the audit trail', async () => {
    const created = await admin.post('/api/users', { username: 'lockme', display_name: 'Lock Me', role: 'viewer', password: 'a fine long passphrase' });
    assert.equal(created.status, 201);
    const anon = new Client(k.base);
    for (let i = 0; i < 8; i++) await anon.post('/api/auth/login', { username: 'lockme', password: `wrong ${i}` });
    const locked = await eventually('action=session.account_locked', (e) => e.target === `#${created.body.id}`);
    assert.ok(locked, 'the lock-out names the account by id');
    assert.equal(locked.outcome, 'failure');
    assert.equal(locked.username, 'lockme', 'and is tied to it');
    assert.ok((await events('action=session.login&outcome=success')).some((e) => e.username === 'analyst' && e.category === 'authentication'));

    assert.equal((await admin.patch(`/api/users/${created.body.id}`, { role: 'admin', reason: 'Covering on-call' })).status, 200);
    const promoted = (await events('action=user.update')).find((e) => e.target === `#${created.body.id}`);
    assert.ok(promoted);
    assert.equal(promoted.detail.role, 'admin');
    assert.equal(promoted.detail.role_from, 'viewer');
    assert.equal(promoted.severity, 'minor', 'a new administrator deserves attention');
    assert.equal(promoted.username, 'admin', 'the acting administrator');
  });

  test('denied requests and invalid tokens, but not a signed-out browser asking who it is', async () => {
    assert.equal((await analyst.get('/api/audit')).status, 403);
    const denied = (await events('action=authz.denied')).find((e) => e.target === 'GET /api/audit');
    assert.ok(denied, 'the route is the target');
    assert.equal(denied.username, 'analyst');
    assert.equal(denied.outcome, 'denied');

    assert.equal((await new Client(k.base, 'kernel_pat_not-a-real-token').get('/api/problems')).status, 401);
    assert.ok((await events('action=auth.token_invalid')).some((e) => e.target === 'GET /api/problems'));

    const before = (await events('action=authn')).length;
    assert.equal((await new Client(k.base).get('/api/auth/me')).status, 401);
    assert.equal((await events('action=authn')).length, before);
  });

  test('an API token used from a new address', async () => {
    const created = (await analyst.post('/api/tokens', { name: 'roaming', scopes: ['read'] })).body;
    // As if the token had last been used elsewhere.
    await ownerQuery("UPDATE api_tokens SET last_used_ip = '203.0.113.7' WHERE id = $1", [created.id]);
    assert.equal((await new Client(k.base, created.token).get('/api/problems')).status, 200);
    const seen = (await events('action=auth.token_new_address')).find((e) => e.token_prefix === created.prefix);
    assert.ok(seen, 'the first use from this address is flagged');
    assert.equal(seen.detail.previous_ip, '203.0.113.7');
    assert.equal(seen.username, 'analyst');
    await new Client(k.base, created.token).get('/api/problems');
    assert.equal((await events('action=auth.token_new_address')).filter((e) => e.token_prefix === created.prefix).length, 1, 'once per address');
  });

  test('MCP writes and failures are stored, reads only logged', async () => {
    const mcp = new McpClient({ name: 'kernel-tests', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    try {
      const made: any = await mcp.callTool({ name: 'create_problem', arguments: { title: 'Via an agent', impact: 3, urgency: 3 } });
      assert.ok(!made.isError, made.content?.[0]?.text);
      await mcp.callTool({ name: 'get_problem', arguments: { ref: 'PRB999999' } });
      await mcp.callTool({ name: 'list_reference_data', arguments: {} });
    } finally {
      await mcp.close();
    }
    const calls = await events('action=mcp.tool_call');
    assert.ok(calls.some((e) => e.detail.tool === 'create_problem' && e.outcome === 'success' && e.channel === 'mcp'));
    assert.ok(calls.some((e) => e.detail.tool === 'get_problem' && e.outcome === 'failure' && e.target === 'PRB999999'));
    assert.ok(!calls.some((e) => e.detail.tool === 'list_reference_data'), 'successful reads stay in the log stream');
  });

  test('CSP reports and exports', async () => {
    const res = await fetch(`${k.base}/api/csp-report`, { method: 'POST', headers: { 'Content-Type': 'application/csp-report' }, body: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'https://evil.example/x.js' } }) });
    assert.equal(res.status, 204);
    const csp = (await events('action=web.csp_violation'))[0];
    assert.equal(csp.detail.blocked, 'https://evil.example/x.js');
    assert.equal((await admin.get('/api/audit.csv')).status, 200);
    assert.ok((await events('category=data_access')).some((e) => e.action === 'audit_log.export'));
  });

  test('admins only, filters, a summary, and the application cannot rewrite them', async () => {
    assert.equal((await analyst.get('/api/security-events')).status, 403);
    assert.equal((await analyst.get('/api/security-events/summary')).status, 403);
    const summary = (await admin.get('/api/security-events/summary')).body;
    assert.ok(summary.outcomes.failure >= 2);
    assert.ok(summary.top.some((t: any) => t.action === 'auth.login_failed'));
    const warnings = await events('min_severity=minor');
    assert.ok(warnings.length > 0 && warnings.every((e) => ['minor', 'major', 'critical'].includes(e.severity)));
    assert.ok((await events('user=analyst')).every((e) => e.username === 'analyst'));

    const { pool } = await import('../../src/db.js');
    await assert.rejects(pool.query("UPDATE security_events SET outcome = 'success'"), /permission denied/);
  });
});
