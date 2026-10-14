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
    assert.deepEqual(trail.rows[0].changes, { classification: { from: 'normal', to: 'confidential' } });
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
