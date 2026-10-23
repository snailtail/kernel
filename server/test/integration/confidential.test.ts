import assert from 'node:assert/strict';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, PASSWORD, skip, startKernel, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: unknown }) => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);
const SECRET_TEXT = 'Board member mailbox compromised via forwarding rule';

describe('confidential records (#61)', { skip }, () => {
  let k: Harness;
  let analyst: Client, analyst2: Client, pm: Client, viewer: Client;
  let ref: string;

  before(async () => {
    k = await startKernel();
    [analyst, analyst2, pm, viewer] = await Promise.all([k.login('analyst'), k.login('analyst2'), k.login('pm'), k.login('viewer')]);
    const p = await analyst.post('/api/problems', { title: 'Mailbox incident follow-up', description: SECRET_TEXT, workaround: `Disable rule: ${SECRET_TEXT}` });
    ok(p);
    ref = p.body.ref;
    ok(await analyst.post(`/api/problems/${ref}/comments`, { body: `Note: ${SECRET_TEXT}` }));
    const up = await fetch(`${k.base}/api/records/${ref}/attachments?filename=headers.txt`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: analyst.cookie!, 'X-Kernel-Request': '1' }, body: new TextEncoder().encode(SECRET_TEXT) });
    assert.ok(up.ok);
  });
  after(async () => k?.close());

  test('marking a record confidential takes a reason and is audited', async () => {
    assert.equal((await viewer.put(`/api/records/${ref}/classification`, { classification: 'confidential', reason: 'x' })).status, 403);
    assert.equal((await analyst.put(`/api/records/${ref}/classification`, { classification: 'confidential' })).status, 400, 'a reason is required');
    ok(await analyst.put(`/api/records/${ref}/classification`, { classification: 'confidential', reason: 'Concerns a board member' }));
    const trail = await ownerQuery("SELECT changes FROM audit_log WHERE action = 'classification' AND entity_ref = $1", [ref]);
    assert.deepEqual(trail.rows[0].changes, { classification: { from: 'normal', to: 'confidential' }, retired_articles: [] });
  });

  test('the people on the record read it; others see the record, not its text', async () => {
    // Positive control: the creator reads everything.
    const mine = (await analyst.get(`/api/problems/${ref}`)).body;
    assert.equal(mine.description, SECRET_TEXT);
    assert.equal(mine.classification, 'confidential');
    const other = await analyst2.get(`/api/problems/${ref}`);
    assert.equal(other.status, 200, 'the record itself is visible');
    assert.equal(other.body.title, 'Mailbox incident follow-up');
    assert.equal(other.body.description, null);
    assert.equal(other.body.workaround, null);
    assert.equal(other.body.confidential_masked, true);
    assert.equal(JSON.stringify(other.body).includes(SECRET_TEXT), false, 'not in comments or history either');
    // Search finds it by title, without the text.
    const hits = (await analyst2.get('/api/search?q=Mailbox incident')).body;
    const hit = hits.find((h: any) => h.ref === ref);
    assert.ok(hit, 'found by title');
    assert.equal(JSON.stringify(hits).includes(SECRET_TEXT), false);
    // No blind overwrite, no attachment.
    assert.equal((await analyst2.patch(`/api/problems/${ref}`, { description: 'overwritten' })).status, 403);
    const att = (await analyst.get(`/api/records/${ref}/attachments`)).body[0];
    assert.equal((await analyst.get(`/api/attachments/${att.id}/text`)).status, 200, 'positive control: the creator opens it');
    assert.equal((await analyst2.get(`/api/attachments/${att.id}/text`)).status, 403);
  });

  test("agents and exports always get the masked text, even for the record's own people", async () => {
    const mcp = new McpClient({ name: 'conf', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const res: any = await mcp.callTool({ name: 'get_record', arguments: { ref } });
    const text = res.content[0].text;
    assert.ok(text.includes('Mailbox incident follow-up'), 'positive control: the agent gets the record');
    assert.equal(text.includes(SECRET_TEXT), false);
    await mcp.close();
    const md = await fetch(`${k.base}/api/problems/${ref}/export.md`, { headers: { Cookie: analyst.cookie! } }).then((r) => r.text());
    assert.ok(md.includes('Mailbox incident follow-up'));
    assert.equal(md.includes(SECRET_TEXT), false);
    assert.match(md, /Confidential/);
  });

  test('masked text is not searchable: outsiders find a confidential record by its title only', async () => {
    // Positive controls: the creator finds it by a word from the masked text; an outsider finds it by title.
    assert.ok((await analyst.get('/api/search?q=forwarding')).body.some((h: any) => h.ref === ref), 'the creator finds it by its text');
    assert.ok((await analyst2.get('/api/search?q=Mailbox')).body.some((h: any) => h.ref === ref), 'an outsider finds it by its title');
    assert.equal((await analyst2.get('/api/search?q=forwarding')).body.some((h: any) => h.ref === ref), false, 'but not by a word only in the masked text');
    assert.ok((await analyst.get('/api/problems/similar?text=forwarding rule compromised')).body.some((h: any) => h.ref === ref), 'similar problems: positive control');
    assert.equal((await analyst2.get('/api/problems/similar?text=forwarding rule compromised')).body.some((h: any) => h.ref === ref), false);
  });

  test('no blind overwrites over any channel: REST transitions, actions and agents (#156)', async () => {
    const text = async () => (await ownerQuery('SELECT description, root_cause, resolution FROM problems WHERE ref = $1', [ref])).rows[0];
    const was = await text();
    assert.equal(was.description, SECRET_TEXT);
    // REST: a transition or an action carrying masked text, by someone not on the record.
    assert.equal((await analyst2.post(`/api/problems/${ref}/transition`, { to: 'analysis', root_cause: 'overwritten' })).status, 403);
    const action = await analyst.post(`/api/problems/${ref}/actions`, { title: 'Remove the rule', description: SECRET_TEXT });
    ok(action);
    assert.equal((await analyst2.patch(`/api/problems/${ref}/actions/${action.body.id}`, { description: 'overwritten' })).status, 403);
    ok(await analyst2.patch(`/api/problems/${ref}/actions/${action.body.id}`, { due_date: '2030-01-01' }));
    ok(await analyst2.post(`/api/problems/${ref}/comments`, { body: 'Can I help?' }));
    // Agents never read the text, so they cannot change it, even with the creator's token.
    const plain = await analyst.post('/api/problems', { title: 'Printer queue stuck', description: 'first' });
    ok(plain);
    const mcp = new McpClient({ name: 'conf-write', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => (await mcp.callTool({ name, arguments: args })) as any;
    assert.equal((await call('update_problem', { ref: plain.body.ref, description: 'second' })).isError, undefined, 'positive control: a normal record');
    for (const [name, args] of [['update_problem', { description: 'overwritten' }], ['transition_problem', { to: 'analysis', resolution: 'overwritten' }]] as const) {
      const res = await call(name, { ref, ...args });
      assert.equal(res.isError, true, name);
      assert.match(res.content[0].text, /confidential/);
    }
    await mcp.close();
    assert.deepEqual(await text(), was, 'the text is unchanged');
    assert.equal((await ownerQuery('SELECT description FROM actions WHERE id = $1', [action.body.id])).rows[0].description, SECRET_TEXT);
  });

  test('list filters are not an oracle either: problems, the KEDB, incidents and changes (MCP too)', async () => {
    const inc = await analyst.post('/api/incidents', { title: 'VIP mailbox alert', description: SECRET_TEXT });
    ok(inc);
    const chg = await analyst.post('/api/changes', { title: 'Remove mailbox rule', description: SECRET_TEXT });
    ok(chg);
    for (const r of [inc.body.ref, chg.body.ref]) ok(await analyst.put(`/api/records/${r}/classification`, { classification: 'confidential', reason: 'Concerns a board member' }));
    const before = (await ownerQuery('SELECT status, known_error_at FROM problems WHERE ref = $1', [ref])).rows[0];
    await ownerQuery("UPDATE problems SET status = 'known_error', known_error_at = now() WHERE ref = $1", [ref]);
    const lists: [string, string][] = [
      [`/api/problems?status=all&q=`, ref],
      [`/api/kedb?q=`, ref],
      [`/api/incidents?status=all&q=`, inc.body.ref],
      [`/api/changes?status=all&q=`, chg.body.ref],
    ];
    const found = async (c: Client, url: string, r: string) => (await c.get(url)).body.some((h: any) => h.ref === r);
    for (const [url, r] of lists) {
      assert.ok(await found(analyst, `${url}forwarding`, r), `${url}: the creator finds it by a word from its text (positive control)`);
      assert.equal(await found(analyst2, `${url}forwarding`, r), false, `${url}: an outsider does not`);
      assert.ok(await found(analyst2, `${url}mailbox`, r), `${url}: an outsider finds it by its title`);
    }
    // Agents never read confidential text, so they cannot search it either, even as the record's creator.
    const mcp = new McpClient({ name: 'conf-lists', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => ((await mcp.callTool({ name, arguments: args })) as any).content[0].text as string;
    assert.ok((await call('list_incidents', { q: 'mailbox', status: 'all' })).includes(inc.body.ref), 'positive control: by title');
    assert.equal((await call('list_incidents', { q: 'forwarding', status: 'all' })).includes(inc.body.ref), false);
    assert.equal((await call('search_known_errors', { q: 'forwarding' })).includes(ref), false);
    await mcp.close();
    await ownerQuery('UPDATE problems SET status = $2, known_error_at = $3 WHERE ref = $1', [ref, before.status, before.known_error_at]);
  });

  test('a confidential record is not copied into a knowledge article', async () => {
    const p = (await pm.post('/api/problems', { title: 'Known issue with VPN', description: 'secret detail', workaround: 'reconnect' })).body;
    await ownerQuery("UPDATE problems SET status = 'known_error', known_error_at = now() WHERE ref = $1", [p.ref]);
    const article = await pm.post(`/api/problems/${p.ref}/article`, {});
    assert.equal(article.status, 201, 'positive control: a known error is published');
    ok(await pm.put(`/api/records/${p.ref}/classification`, { classification: 'confidential', reason: 'Contains customer details' }));
    assert.equal((await pm.get(`/api/articles/${article.body.ref}`)).body.status, 'retired', 'the synced article is retired');
    assert.equal((await pm.post(`/api/problems/${p.ref}/article`, {})).status, 400, 'and not published again');
  });

  test('"create from" copies only text the caller may read: problem from incident, change from problem, agents (#158)', async () => {
    const inc = await analyst.post('/api/incidents', { title: 'Board laptop alert', description: SECRET_TEXT });
    ok(inc);
    ok(await analyst.put(`/api/records/${inc.body.ref}/classification`, { classification: 'confidential', reason: 'Concerns a board member' }));
    // Positive control: a person on the incident gets its text copied.
    const own = await analyst.post(`/api/incidents/${inc.body.ref}/problem`, {});
    ok(own);
    assert.ok(own.body.description.includes(SECRET_TEXT));
    // Someone not on it creates the problem, and so may read it, but the incident's text stays behind.
    const theirs = await analyst2.post(`/api/incidents/${inc.body.ref}/problem`, {});
    ok(theirs);
    assert.equal(theirs.body.title, 'Board laptop alert', 'the title still comes along');
    assert.equal(theirs.body.classification, 'confidential');
    const fresh = (await analyst2.get(`/api/problems/${theirs.body.ref}`)).body;
    assert.match(fresh.description, /confidential, its text is not included/);
    assert.equal(fresh.confidential_masked, undefined, 'analyst2 reads the new problem in full');
    assert.equal(JSON.stringify(theirs.body).includes(SECRET_TEXT) || JSON.stringify(fresh).includes(SECRET_TEXT), false, 'not in the response, the problem or its history');
    const trail = await ownerQuery("SELECT changes FROM audit_log WHERE entity_type = 'copy_text' AND action = 'withheld' AND entity_ref = $1", [inc.body.ref]);
    assert.deepEqual(trail.rows.map((r) => r.changes.path), ['incident-to-problem'], 'withholding is audited');
    // Change from problem: the root cause and the fix stay behind too.
    const prb = await analyst.post('/api/problems', { title: 'Laptop forwarding rule', description: 'x' });
    ok(prb);
    await ownerQuery('UPDATE problems SET root_cause = $2, resolution = $2 WHERE ref = $1', [prb.body.ref, SECRET_TEXT]);
    ok(await analyst.put(`/api/records/${prb.body.ref}/classification`, { classification: 'confidential', reason: 'Concerns a board member' }));
    const ownChange = await analyst.post(`/api/problems/${prb.body.ref}/change`, {});
    ok(ownChange);
    assert.ok(ownChange.body.description.includes(SECRET_TEXT), 'positive control');
    const change = await analyst2.post(`/api/problems/${prb.body.ref}/change`, {});
    ok(change);
    assert.equal(JSON.stringify(change.body).includes(SECRET_TEXT), false);
    assert.equal((await ownerQuery('SELECT description FROM changes WHERE ref = $1', [change.body.ref])).rows[0].description.includes(SECRET_TEXT), false);
    // Agents never read confidential text, so they never copy it either, even with the creator's token.
    const mcp = new McpClient({ name: 'conf-copy', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await mcp.callTool({ name, arguments: args })) as any).content[0].text);
    const viaAgent = [(await call('create_problem_from_incident', { ref: inc.body.ref })).ref, (await call('raise_change_for_problem', { problem: prb.body.ref })).ref];
    await mcp.close();
    const copied = await ownerQuery('SELECT description FROM problems WHERE ref = $1 UNION ALL SELECT description FROM changes WHERE ref = $2', viaAgent);
    assert.equal(copied.rows.length, 2);
    for (const r of copied.rows) assert.equal(r.description.includes(SECRET_TEXT), false);
  });

  test("a review's factors and follow-ups go along only for people who may read them (#158)", async () => {
    const inc = (await analyst.post('/api/incidents', { title: 'Board laptop outage', impact: 2, urgency: 2 })).body.ref;
    ok(await analyst.post(`/api/incidents/${inc}/review`, {}));
    for (const kind of ['factor', 'factor', 'follow_up', 'gap']) ok(await analyst.post(`/api/incidents/${inc}/review/items`, { kind, body: SECRET_TEXT }));
    ok(await analyst.put(`/api/records/${inc}/classification`, { classification: 'confidential', reason: 'Concerns a board member' }));
    const items = (await ownerQuery('SELECT x.id, x.kind FROM incident_review_items x JOIN incident_reviews r ON r.id = x.review_id JOIN incidents i ON i.id = r.incident_id WHERE i.ref = $1 ORDER BY x.id', [inc])).rows;
    const [f1, f2, follow, gap] = items.map((x) => x.id);
    const problemOf = async (item: number) => (await ownerQuery('SELECT p.ref, p.title, p.description FROM incident_review_items x JOIN problems p ON p.id = x.problem_id WHERE x.id = $1', [item])).rows[0];
    // Positive control: the incident's creator gets the factor's words.
    ok(await analyst.post(`/api/incidents/${inc}/review/items/${f1}/problem`, {}));
    assert.ok((await problemOf(f1)).description.includes(SECRET_TEXT));
    ok(await analyst2.post(`/api/incidents/${inc}/review/items/${f2}/problem`, {}));
    const p = await problemOf(f2);
    assert.equal(`${p.title} ${p.description}`.includes(SECRET_TEXT), false, 'neither as the title nor as the description');
    assert.equal(JSON.stringify((await analyst2.get(`/api/problems/${p.ref}`)).body).includes(SECRET_TEXT), false);
    // A follow-up → action on that problem needs a title of its own, and leaves the words behind.
    assert.equal((await analyst2.post(`/api/incidents/${inc}/review/items/${follow}/action`, { problem: p.ref })).status, 400);
    ok(await analyst2.post(`/api/incidents/${inc}/review/items/${follow}/action`, { problem: p.ref, title: 'Check the laptop' }));
    const action = (await ownerQuery('SELECT a.title, a.description FROM incident_review_items x JOIN actions a ON a.id = x.action_id WHERE x.id = $1', [follow])).rows[0];
    assert.equal(`${action.title} ${action.description}`.includes(SECRET_TEXT), false);
    // A gap → improvement.
    ok(await analyst2.post(`/api/incidents/${inc}/review/items/${gap}/improvement`, {}));
    const m = (await ownerQuery('SELECT m.title, m.description FROM incident_review_items x JOIN improvements m ON m.id = x.improvement_id WHERE x.id = $1', [gap])).rows[0];
    assert.equal(`${m.title} ${m.description}`.includes(SECRET_TEXT), false);
    assert.match(m.description, /confidential, its text is not included/);
  });

  test('revealing takes step-up and a reason, lasts 15 minutes and is audited', async () => {
    await ownerQuery("UPDATE sessions SET reauth_at = now() - interval '1 hour' WHERE user_id = (SELECT id FROM users WHERE username = 'analyst2')");
    assert.equal((await analyst2.post(`/api/records/${ref}/reveal`, { reason: 'Taking over the case' })).status, 403, 'step-up first');
    ok(await analyst2.post('/api/auth/reauth', { password: PASSWORD }));
    assert.equal((await analyst2.post(`/api/records/${ref}/reveal`, {})).status, 400, 'a reason is required');
    const r = await analyst2.post(`/api/records/${ref}/reveal`, { reason: 'Taking over the case' });
    ok(r);
    assert.equal((await analyst2.get(`/api/problems/${ref}`)).body.description, SECRET_TEXT);
    const trail = await ownerQuery("SELECT reason FROM audit_log WHERE action = 'reveal' AND entity_ref = $1", [ref]);
    assert.equal(trail.rows[0].reason, 'Taking over the case');
    assert.ok((await analyst.get(`/api/problems/${ref}`)).body.activity.some((a: any) => a.body?.startsWith('Revealed the confidential text')), 'the people on the record see who looked');
    // A reveal ends.
    await ownerQuery("UPDATE record_reveals SET expires_at = now() - interval '1 second'");
    assert.equal((await analyst2.get(`/api/problems/${ref}`)).body.description, null);
    // The manager still has to reveal: overseeing is not working on it.
    assert.equal((await pm.get(`/api/problems/${ref}`)).body.description, null);
  });
});
