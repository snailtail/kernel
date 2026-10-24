// Restricted records and team scoping (#53, ADR 0002). The leak harness seeds restricted records whose texts carry a
// unique marker, then calls every GET route in the OpenAPI document and every read-only MCP tool and resource as
// people who may not see them, and asserts that the marker never appears. New routes and tools are covered as they
// are added, because the lists come from the running Kernel.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

const MARKER = `LEAK-${randomBytes(4).toString('hex')}`;
// Searches use the random part only, so a tool that echoes its input is not mistaken for a leak.
const PROBE = MARKER.slice(5);
/** In an ordinary record, for the positive controls: what everyone may see must actually come through. */
const OPEN_MARKER = `OPEN-${randomBytes(4).toString('hex')}`;
/** Setup calls must succeed: a refused setup would make a test of absence pass for the wrong reason. */
const ok = (r: { status: number; body: unknown }) => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);

async function peekStream(url: string, cookie: string) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers: { Cookie: cookie }, signal: ctrl.signal });
  let text = '';
  const timer = setTimeout(() => ctrl.abort(), 300);
  try {
    for await (const chunk of res.body as any) text += Buffer.from(chunk).toString('utf8');
  } catch {
    // aborted after the timeout
  }
  clearTimeout(timer);
  return text;
}

describe('visibility and restricted records (#53)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, analyst2: Client, viewer: Client;
  const ids: Record<string, number> = {};
  let db: typeof import('../../src/core/db.js');
  let sec: any;
  const restricted: Record<'problem' | 'incident' | 'change', string> = {} as any;
  let open: string;
  let openWithMarker: string;

  before(async () => {
    process.env.KERNEL_SECRET_KEY = 'visibility-test-key-0123456789abcdefghij';
    k = await startKernel();
    [admin, pm, analyst, analyst2, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('analyst2'), k.login('viewer')]);
    db = await import('../../src/core/db.js');
    for (const u of (await db.query('SELECT id, username FROM users')).rows) ids[u.username] = u.id;
    sec = (await admin.post('/api/teams', { name: 'Security' })).body;
    ok(await admin.put(`/api/teams/${sec.id}/members`, { members: [{ user_id: ids.analyst, role: 'lead' }] }));
    const ci = (await pm.post('/api/cis', { name: 'vault01', ci_type: 'virtual_machine' })).body.ref;

    // Restricted records, created by the analyst (in the Security team), with the marker everywhere.
    const p = (await analyst.post('/api/problems', { title: `Credential leak ${MARKER}`, description: `Details ${MARKER}` })).body;
    const i = (await analyst.post('/api/incidents', { title: `Breach ${MARKER}`, description: `Indicators ${MARKER}`, cis: [ci] })).body;
    const c = (await analyst.post('/api/changes', { title: `Rotate keys ${MARKER}`, description: `Plan ${MARKER}`, cis: [ci] })).body;
    for (const [type, ref] of [['problem', p.ref], ['incident', i.ref], ['change', c.ref]] as const) {
      restricted[type] = ref;
      assert.equal((await analyst.put(`/api/records/${ref}/visibility`, { restricted: true, teams: [sec.id] })).status, 400, 'a reason is required');
      const r = await analyst.put(`/api/records/${ref}/visibility`, { restricted: true, teams: [sec.id], reason: 'Security investigation' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    ok(await analyst.post(`/api/problems/${p.ref}/comments`, { body: `Note ${MARKER}` }));
    await analyst.post(`/api/incidents/${i.ref}/problem`, {}).catch(() => {});
    // An ordinary problem that links to the restricted ones: the links must not show.
    open = (await analyst.post('/api/problems', { title: 'Ordinary problem', description: 'nothing secret' })).body.ref;
    openWithMarker = (await analyst.post('/api/problems', { title: `Ordinary ${OPEN_MARKER}` })).body.ref;
    ok(await analyst.post(`/api/records/${open}/links`, { to: p.ref }));
    ok(await analyst.post(`/api/records/${open}/links`, { to: i.ref }));
    const uploaded = await fetch(`${k.base}/api/records/${i.ref}/attachments?filename=${MARKER}.log`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: analyst.cookie!, 'X-Kernel-Request': '1' }, body: new TextEncoder().encode(`log ${MARKER}`),
    });
    assert.ok(uploaded.ok, `attachment upload: ${uploaded.status}`);
  });
  after(async () => {
    delete process.env.KERNEL_SECRET_KEY;
    await k?.close();
  });

  const leaks = (body: unknown) => JSON.stringify(body ?? '').includes(MARKER);
  const around = (body: unknown) => { const t = JSON.stringify(body ?? ''); const i = t.indexOf(MARKER); return t.slice(Math.max(0, i - 200), i + 40); };

  test('every table attached to a problem, incident, change, improvement, request, work item or sprint has row-level security, or is a reviewed exception', async () => {
    const { rows } = await ownerQuery(
      `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN pg_class t ON t.relname = c.table_name AND t.relkind = 'r'
       WHERE c.table_schema = 'public' AND c.column_name IN ('incident_id', 'problem_id', 'change_id', 'review_id', 'improvement_id', 'request_id', 'work_item_id', 'sprint_id') AND NOT t.relrowsecurity
         -- In the audit trail and security events, request_id is the HTTP request's id, not a service request.
         AND NOT (c.column_name = 'request_id' AND c.table_name IN ('audit_log', 'security_events')) ORDER BY 1`,
    );
    // Monitoring alerts are operational data shared by everyone on call; external records are references to other tools.
    assert.deepEqual(rows.map((r: any) => r.table_name), ['alerts', 'external_records'], 'a new table that belongs to a record gets an RLS policy like 119_visibility.sql');
  });

  test('the people on a restricted record see it; others get the same 404 as for a record that does not exist', async () => {
    for (const ref of Object.values(restricted)) {
      assert.equal((await analyst.get(`/api/records/${ref}`)).status, 200, `${ref}: the creator (and Security member) sees it`);
      for (const c of [pm, analyst2, viewer, admin]) {
        const r = await c.get(`/api/records/${ref}`);
        const none = await c.get(`/api/records/${ref.slice(0, 3)}999999`);
        assert.equal(r.status, 404, `${ref} is hidden`);
        assert.deepEqual(Object.keys(r.body), Object.keys(none.body), 'no existence oracle');
      }
    }
    const links = (await analyst2.get(`/api/problems/${open}`)).body.links;
    assert.ok(!links.some((l: any) => Object.values(restricted).includes(l.reference)), 'links to hidden records are hidden');
    assert.ok((await analyst.get(`/api/problems/${open}`)).body.links.some((l: any) => l.reference === restricted.problem), 'and visible to the team');
    assert.equal((await analyst2.post(`/api/records/${open}/links`, { to: restricted.change })).status, 404, 'linking to a hidden ref looks like a missing one');
  });

  test('LEAK HARNESS: no GET route shows the marker to people who may not see the records', async () => {
    const doc = (await viewer.get('/api/openapi.json')).body;
    const paths = Object.entries(doc.paths).filter(([, ops]: any) => ops.get).map(([p]) => p);
    assert.ok(paths.length > 60, `routes found: ${paths.length}`);
    let calls = 0;
    for (const who of [pm, analyst2, viewer, admin]) {
      for (const path of paths) {
        if (path.startsWith('/api/admin/audit') || path === '/api/audit' || path === '/api/audit.csv') continue; // the audit trail lists refs by design (ADR 0001: no free text)
        const variants = path.includes('{ref}') ? Object.values(restricted).map((r) => path.replace('{ref}', r)) : [path.replace(/\{[^}]+\}/g, '1')];
        for (const url of variants) {
          for (const q of ['', `?q=${MARKER}`]) {
            // The live event stream never ends: read what it sends in a moment, then hang up (#70).
            const r = url === '/api/live' ? { body: await peekStream(`${k.base}${url}${q}`, who.cookie!) } : await who.get(url.replace(/\{[^}]+\}/g, '1') + q);
            calls++;
            assert.ok(!leaks(r.body), `${url}${q} leaked to a ${who === admin ? 'admin' : who === pm ? 'manager' : who === viewer ? 'viewer' : 'analyst'}: …${around(r.body)}`);
          }
        }
      }
    }
    assert.ok(calls > 200);
    // Positive control: the same walk, as a member of the record's team, does reach the data – otherwise a route that
    // failed for everyone would pass as "no leak".
    const reached: string[] = [];
    for (const path of paths) {
      if (!path.includes('{ref}')) continue;
      for (const ref of Object.values(restricted)) {
        if (leaks((await analyst.get(path.replace('{ref}', ref).replace(/\{[^}]+\}/g, '1'))).body)) reached.push(path);
      }
    }
    for (const must of ['/api/problems/{ref}', '/api/incidents/{ref}', '/api/changes/{ref}', '/api/records/{ref}']) {
      assert.ok(reached.includes(must), `the team member sees the marker through ${must} (found through: ${[...new Set(reached)].join(', ')})`);
    }
    assert.ok(leaks((await analyst.get(`/api/search?q=${MARKER}`)).body), 'and through search');
    // Managers are told that their numbers leave something out, without a count.
    assert.equal((await pm.get('/api/meta')).body.hidden_records, true);
    assert.equal((await analyst.get('/api/meta')).body.hidden_records, false);
  });

  test('LEAK HARNESS: no read-only MCP tool or resource shows the marker, even to the record\'s own team through an agent', async () => {
    for (const user of ['pm', 'analyst2', 'admin', 'analyst'] as const) {
      const mcp = new McpClient({ name: 'leak', version: '1' });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor(user)}` } } }));
      const { tools } = await mcp.listTools();
      const readOnly = tools.filter((t) => t.annotations?.readOnlyHint);
      assert.ok(readOnly.length > 20);
      for (const t of readOnly) {
        const props: Record<string, any> = (t.inputSchema as any).properties ?? {};
        for (const ref of Object.values(restricted)) {
          const args: Record<string, unknown> = {};
          for (const [name, schema] of Object.entries(props)) {
            const type = schema.type ?? schema.anyOf?.[0]?.type;
            if (schema.enum) args[name] = schema.enum[0];
            else if (type === 'string') args[name] = /ref|incident|problem|change|article|record/i.test(name) ? ref : PROBE;
            else if (type === 'number' || type === 'integer') args[name] = 1;
            else if (type === 'boolean') args[name] = false;
            else if (type === 'array') args[name] = [ref];
          }
          const res: any = await mcp.callTool({ name: t.name, arguments: args }).catch((err) => ({ content: [{ text: String(err) }] }));
          assert.ok(!leaks(res), `MCP ${t.name} leaked to ${user} (restricted records are not for agents by default): …${around(res)}`);
        }
      }
      for (const r of (await mcp.listResources()).resources) {
        assert.ok(!leaks(await mcp.readResource({ uri: r.uri })), `resource ${r.uri} leaked`);
      }
      // Positive control: the tools do return record text – an ordinary record's marker comes through.
      const seen: any = await mcp.callTool({ name: 'get_record', arguments: { ref: openWithMarker } });
      assert.ok(JSON.stringify(seen).includes(OPEN_MARKER), `get_record returns an ordinary record's text to ${user}`);
      await mcp.close();
    }
  });

  test('notifications go only to people who may see the record; webhooks carry only the ref', async () => {
    await db.query("DELETE FROM notifications");
    // The analyst assigns the restricted problem to analyst2, who then may see it (the assignee always may).
    assert.equal((await analyst.patch(`/api/problems/${restricted.problem}`, { assignee_id: ids.analyst2 })).status, 200);
    assert.equal((await analyst2.get(`/api/problems/${restricted.problem}`)).status, 200, 'the assignee sees it');
    ok(await analyst.patch(`/api/problems/${restricted.problem}`, { assignee_id: ids.analyst }));
    assert.equal((await analyst2.get(`/api/problems/${restricted.problem}`)).status, 404, 'and no longer when unassigned');
    const notes = (await db.query('SELECT user_id, title FROM notifications')).rows;
    assert.ok(notes.some((n: any) => n.user_id === ids.analyst2), 'positive control: the assignee was notified');
    assert.ok(!notes.some((n: any) => n.user_id === ids.pm && leaks(n.title)));
    const created = await admin.post('/api/webhooks', { name: 'Leak test', url: 'https://hooks.example.com/x', events: [] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const hook = created.body;
    await analyst.patch(`/api/problems/${restricted.problem}`, { impact: 1 });
    const payloads = (await db.query('SELECT payload FROM webhook_deliveries WHERE webhook_id = $1', [hook.id])).rows.map((r: any) => r.payload);
    assert.ok(payloads.length > 0);
    assert.ok(payloads.every((p: any) => !leaks(p) && p.problem.restricted === true));
  });

  test('break-glass opens a record for an administrator for an hour, with a reason, and tells the people on it', async () => {
    assert.equal((await pm.post(`/api/records/${restricted.incident}/break-glass`, { reason: 'Audit' })).status, 403);
    assert.equal((await admin.post(`/api/records/${restricted.incident}/break-glass`, {})).status, 400, 'a reason is required');
    const r = await admin.post(`/api/records/${restricted.incident}/break-glass`, { reason: 'Regulator request #9' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await admin.get(`/api/incidents/${restricted.incident}`)).status, 200);
    assert.equal((await admin.get(`/api/problems/${restricted.problem}`)).status, 404, 'only that record');
    const status = (await admin.get('/api/admin/security')).body.checks.find((c: any) => c.id === 'break_glass');
    assert.equal(status.ok, false);
    const audited = (await db.query("SELECT reason FROM audit_log WHERE action = 'break_glass'")).rows;
    assert.equal(audited[0].reason, 'Regulator request #9');
    assert.ok((await db.query("SELECT 1 FROM notifications WHERE user_id = $1 AND ref = $2", [ids.analyst, restricted.incident])).rows[0], 'the team lead is told');
  });

  test('team scoping: when on for incidents, analysts see their teams\' work, unteamed work and their own', async () => {
    const ops = (await admin.post('/api/teams', { name: 'Ops' })).body;
    ok(await admin.put(`/api/teams/${ops.id}/members`, { members: [{ user_id: ids.analyst2 }] }));
    const theirs = (await analyst2.post('/api/incidents', { title: 'Ops disk full', team_id: ops.id })).body.ref;
    const secOnly = (await analyst.post('/api/incidents', { title: 'Security tool down', team_id: sec.id })).body.ref;
    const unteamed = (await analyst.post('/api/incidents', { title: 'Printer' })).body.ref;
    assert.ok(theirs && secOnly && unteamed, 'the incidents were created');
    assert.equal((await admin.put('/api/admin/visibility', { team_scoped: { incident: true, problem: false, change: false }, restricted_categories: [], reason: 'Teams work separately' })).status, 200);
    const list = (await analyst2.get('/api/incidents?status=all')).body.map((i: any) => i.ref);
    assert.ok(list.includes(theirs) && list.includes(unteamed));
    assert.ok(!list.includes(secOnly), 'another team\'s incident is out of sight');
    assert.ok((await pm.get('/api/incidents?status=all')).body.some((i: any) => i.ref === secOnly), 'managers are not team-scoped');
    // Removing someone from a team takes effect on their next request.
    ok(await admin.put(`/api/teams/${ops.id}/members`, { members: [] }));
    assert.equal((await analyst2.get(`/api/incidents/${theirs}`)).status, 200, 'still their own (created by them)');
    await admin.put('/api/admin/visibility', { team_scoped: { incident: false, problem: false, change: false }, restricted_categories: [], reason: 'Back to shared' });
  });

  test('security categories start restricted', async () => {
    const cat = (await pm.post('/api/categories', { name: 'Security incident' })).body;
    ok(await admin.put('/api/admin/visibility', { team_scoped: { incident: false, problem: false, change: false }, restricted_categories: [cat.id], reason: 'Security incidents are need-to-know' }));
    const i = (await analyst.post('/api/incidents', { title: 'Phishing wave', category_id: cat.id })).body;
    assert.equal(i.restricted, true);
    assert.equal((await analyst.get(`/api/incidents/${i.ref}`)).status, 200, 'positive control: the creator sees it');
    assert.equal((await analyst2.get(`/api/incidents/${i.ref}`)).status, 404);
  });

  test('every database call goes through the viewer-aware helpers', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const dir = new URL('../../src/', import.meta.url);
    const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.ts') && f !== 'core/db.ts');
    for (const f of files) {
      const src = await readFile(new URL(f, dir), 'utf8');
      assert.ok(!/rawPool|new pg\.(Pool|Client)\(|pool\.connect\(/.test(src), `${f} must use query()/tx() from db.ts`);
    }
  });
});
