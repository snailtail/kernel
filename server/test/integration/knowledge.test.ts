import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { skip, startKernel, type Client, type Harness } from './harness.js';

describe('knowledge (#47)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, viewer: Client;
  let svc: string, vm: string, ke: string;

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('viewer')]);
    svc = (await pm.post('/api/cis', { name: 'Payroll portal', ci_type: 'business_service' })).body.ref;
    vm = (await pm.post('/api/cis', { name: 'payroll-app01', ci_type: 'virtual_machine' })).body.ref;
    await pm.post(`/api/cis/${vm}/relationships`, { type: 'member_of', target: svc });
    ke = (await analyst.post('/api/problems', { title: 'Payslip PDF export hangs', description: 'Exporting a payslip spins forever.' })).body.ref;
    await analyst.post(`/api/problems/${ke}/cis`, { ci: vm });
    await analyst.post(`/api/problems/${ke}/transition`, { to: 'analysis' });
    await analyst.post(`/api/problems/${ke}/transition`, { to: 'known_error', root_cause: 'Font cache lock', workaround: 'Clear the font cache and export again' });
  });
  after(() => k?.close());

  test('a known error is published in one step, follows the problem and retires with it', async () => {
    assert.equal((await viewer.post(`/api/problems/${ke}/article`, {})).status, 403);
    const a = (await analyst.post(`/api/problems/${ke}/article`, {})).body;
    assert.match(a.ref, /^KB\d{6}$/);
    assert.equal(a.status, 'published');
    assert.equal(a.article_type, 'known_error');
    assert.match(a.body, /## Workaround\n\nClear the font cache/);
    assert.deepEqual(a.cis.map((c: any) => c.ref), [vm]);
    assert.equal((await analyst.post(`/api/problems/${ke}/article`, {})).body.ref, a.ref, 'one article per known error');
    assert.equal((await analyst.get(`/api/problems/${ke}`)).body.knowledge_article.ref, a.ref);

    await analyst.patch(`/api/problems/${ke}`, { workaround: 'Restart the export service' });
    assert.match((await viewer.get(`/api/articles/${a.ref}`)).body.body, /Restart the export service/);
    assert.equal((await analyst.patch(`/api/articles/${a.ref}`, { body: 'edited' })).status, 409, 'edit the problem instead');
    assert.equal((await pm.patch(`/api/articles/${a.ref}`, { audience: 'end_users' })).status, 409, 'known-error articles stay internal');
    const synced = (await viewer.get(`/api/articles/${a.ref}`)).body.activity;
    assert.ok(synced.some((x: any) => x.body === `Synced from ${ke}: workaround`), 'synced changes are in the history');

    await analyst.post(`/api/problems/${ke}/transition`, { to: 'resolved', resolution: 'Font cache fixed in CHG-1' });
    const retired = (await viewer.get(`/api/articles/${a.ref}`)).body;
    assert.equal(retired.status, 'retired');
    assert.ok(retired.activity.some((x: any) => x.body.includes('is resolved')));
  });

  test('drafts are for writers; publishing for end users needs a manager', async () => {
    assert.equal((await viewer.post('/api/articles', { title: 'Reset VPN token' })).status, 403);
    const d = (await analyst.post('/api/articles', { title: 'Reset a VPN token', body: '1. Open the portal\n2. Choose **Reset**', audience: 'end_users', cis: [svc] })).body;
    assert.equal(d.status, 'draft');
    assert.equal((await viewer.get(`/api/articles/${d.ref}`)).status, 404, 'viewers do not see drafts');
    assert.equal((await analyst.post(`/api/articles/${d.ref}/transition`, { to: 'published' })).status, 403);
    const p = (await pm.post(`/api/articles/${d.ref}/transition`, { to: 'published' })).body;
    assert.equal(p.status, 'published');
    assert.ok(p.review_by, 'a review date is set on publishing');
    assert.equal((await viewer.post(`/api/articles/${d.ref}/feedback`, { helpful: true })).body.helpful, 1);
    assert.equal((await viewer.post(`/api/articles/${d.ref}/feedback`, { helpful: false })).body.helpful, 0, 'one vote per person');
    const hits = (await viewer.get('/api/search?q=vpn token')).body;
    assert.ok(hits.some((h: any) => h.ref === d.ref && h.type === 'article'));
  });

  test('suggestions while logging an incident, "used to resolve", and drafts from resolutions', async () => {
    const how = (await analyst.post('/api/articles', { title: 'Payroll portal login loops', body: 'Clear cookies for the payroll portal.', cis: [svc] })).body;
    await analyst.post(`/api/articles/${how.ref}/transition`, { to: 'published' });
    const s = (await analyst.get(`/api/knowledge/suggest?text=${encodeURIComponent('login keeps looping')}&cis=${vm}`)).body;
    assert.equal(s[0].ref, how.ref, 'matched by text and by the service the CI belongs to');
    const inc = (await analyst.post('/api/incidents', { title: 'Login loops on payroll', cis: [vm] })).body;
    assert.ok(inc.suggested_articles.some((a: any) => a.ref === how.ref));
    await analyst.post(`/api/incidents/${inc.ref}/articles-used`, { article: how.ref });
    await analyst.post(`/api/incidents/${inc.ref}/articles-used`, { article: how.ref });
    const after = (await analyst.get(`/api/incidents/${inc.ref}`)).body;
    assert.deepEqual(after.articles_used.map((a: any) => a.ref), [how.ref]);
    assert.equal((await analyst.get(`/api/articles/${how.ref}`)).body.used_count, 1, 'counted once per incident');

    assert.equal((await analyst.post(`/api/incidents/${inc.ref}/article`, {})).status, 400, 'no resolution yet');
    await analyst.post(`/api/incidents/${inc.ref}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Cleared the SSO cookie; added a redirect rule' });
    const draft = (await analyst.post(`/api/incidents/${inc.ref}/article`, {})).body;
    assert.equal(draft.status, 'draft');
    assert.equal(draft.article_type, 'troubleshooting');
    assert.match(draft.body, /## Resolution\n\nCleared the SSO cookie/);
    assert.equal(draft.source_incident_ref, inc.ref);
  });

  test('agents search, read and draft, but cannot publish', async () => {
    const mcp = new McpClient({ name: 'kb', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('pm')}` } } }));
    const call = async (name: string, args: object) => (await mcp.callTool({ name, arguments: args })) as any;
    const found = JSON.parse((await call('search_knowledge', { q: 'payroll login' })).content[0].text);
    assert.ok(found.articles.length > 0 && found.articles[0].title_untrusted && !found.articles[0].title);
    const one = JSON.parse((await call('get_article', { ref: found.articles[0].ref })).content[0].text);
    assert.ok(one.untrusted_content.body !== undefined && one.body === undefined, 'article text is marked as untrusted');
    const drafted = JSON.parse((await call('create_article', { title: 'Agent wrote this', body: 'Steps…' })).content[0].text);
    assert.equal(drafted.status, 'draft');
    assert.equal((await call('transition_article', { ref: drafted.ref, to: 'published' })).isError, true);
    await mcp.close();
  });

  test('the knowledge module can be switched off', async () => {
    assert.equal((await admin.put('/api/admin/modules', { knowledge: false, reason: 'Not used yet' })).status, 200);
    assert.equal((await analyst.get('/api/articles')).status, 404);
    const inc = (await analyst.post('/api/incidents', { title: 'Payroll login loops again' })).body;
    assert.deepEqual(inc.suggested_articles, []);
    await admin.put('/api/admin/modules', { knowledge: true, reason: 'Back on' });
  });
});
