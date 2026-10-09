import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import sharp from 'sharp';
import { skip, startKernel, type Client, type Harness } from './harness.js';

describe('attachments (#51, #74)', { skip }, () => {
  let k: Harness;
  let admin: Client, analyst: Client, viewer: Client;
  let inc: string, prb: string;

  const upload = (c: Client, ref: string, filename: string, data: Buffer) =>
    fetch(`${k.base}/api/records/${ref}/attachments?filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Cookie: c.cookie!, 'X-Kernel-Request': '1' },
      body: new Uint8Array(data),
    }).then(async (r) => ({ status: r.status, body: await r.json() as any }));
  const raw = (c: Client, path: string) => fetch(`${k.base}${path}`, { headers: { Cookie: c.cookie! } });

  before(async () => {
    k = await startKernel();
    [admin, analyst, viewer] = await Promise.all([k.login('admin'), k.login('analyst'), k.login('viewer')]);
    inc = (await analyst.post('/api/incidents', { title: 'Login page broken' })).body.ref;
    prb = (await analyst.post('/api/problems', { title: 'Logins fail' })).body.ref;
  });
  after(() => k?.close());

  test('screenshots are re-encoded without metadata and get a preview and a thumbnail', async () => {
    const photo = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#3366cc' } })
      .withExif({ IFD0: { Artist: 'Anna Berg', Copyright: 'secret place' } })
      .jpeg()
      .toBuffer();
    assert.ok((await sharp(photo).metadata()).exif, 'the test image carries EXIF');
    assert.equal((await upload(viewer, inc, 'shot.jpg', photo)).status, 403);
    const r = await upload(analyst, inc, 'C:\\Users\\anna\\shot "1".jpg', photo);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'image');
    assert.equal(r.body.filename, 'shot 1.jpg', 'path and quotes stripped from the name');
    assert.deepEqual([r.body.width, r.body.height], [2400, 1200]);
    const original = await raw(analyst, `/api/attachments/${r.body.id}`);
    assert.equal(original.headers.get('content-type'), 'image/jpeg');
    assert.match(original.headers.get('content-disposition')!, /^attachment;/);
    assert.equal(original.headers.get('x-content-type-options'), 'nosniff');
    assert.match(original.headers.get('content-security-policy')!, /sandbox/);
    const bytes = Buffer.from(await original.arrayBuffer());
    assert.equal((await sharp(bytes).metadata()).exif, undefined, 'EXIF removed');
    assert.ok(!bytes.includes(Buffer.from('Anna Berg')));
    const preview = await raw(viewer, `/api/attachments/${r.body.id}/preview`);
    assert.equal(preview.status, 200, 'viewers may see what they may read');
    assert.equal((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).width, 1600);
    const list = (await viewer.get(`/api/records/${inc}/attachments`)).body;
    assert.equal(list.length, 1);
    const history = (await analyst.get(`/api/incidents/${inc}`)).body.activity;
    assert.ok(history.some((a: any) => a.body === 'Attached shot 1.jpg'));
  });

  test('the type comes from the content: SVG and HTML are text, executables are refused', async () => {
    const svg = await upload(analyst, prb, 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'));
    assert.equal(svg.body.kind, 'text');
    const served = await raw(analyst, `/api/attachments/${svg.body.id}?inline=1`);
    assert.equal(served.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(served.headers.get('content-disposition')!, /^attachment;/, 'text is never shown inline');
    const fakePng = await upload(analyst, prb, 'image.png', Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('not really')]));
    assert.equal(fakePng.status, 400);
    const exe = await upload(analyst, prb, 'tool.exe', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0xff, 0xfe]));
    assert.equal(exe.status, 400);
    const pdf = await upload(analyst, prb, 'report.pdf', Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'));
    assert.equal(pdf.body.kind, 'pdf');
    const inline = await raw(analyst, `/api/attachments/${pdf.body.id}?inline=1`);
    assert.match(inline.headers.get('content-disposition')!, /^inline;/);
    assert.equal(inline.headers.get('x-frame-options'), 'SAMEORIGIN');
  });

  test('logs are readable in place, with the first error and flags for secrets', async () => {
    const log = ['2026-10-09 10:00:01 INFO start', '2026-10-09 10:00:02 INFO connecting', 'db password=hunter2secret', '2026-10-09 10:00:03 ERROR timeout'].join('\n');
    const r = await upload(analyst, inc, 'app.log', Buffer.from(log));
    assert.deepEqual(r.body.flags, ['credential']);
    const text = (await viewer.get(`/api/attachments/${r.body.id}/text?from=1&limit=2`)).body;
    assert.deepEqual(text.lines, ['2026-10-09 10:00:02 INFO connecting', 'db password=hunter2secret']);
    assert.equal(text.total_lines, 4);
    assert.equal(text.first_error_line, 3);
  });

  test('agents list, read and add attachments; access follows the record', async () => {
    const mcp = new McpClient({ name: 'att', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const call = (name: string, args: object) => mcp.callTool({ name, arguments: args }) as Promise<any>;
    const list = JSON.parse((await call('list_attachments', { ref: inc })).content[0].text);
    const image = list.find((a: any) => a.kind === 'image');
    const read = await call('read_attachment', { id: image.id });
    assert.equal(read.content[0].type, 'image');
    assert.equal(read.content[0].mimeType, 'image/webp');
    const added = JSON.parse((await call('add_attachment', { ref: inc, filename: 'analysis.md', text: '# Findings\nThe pool is exhausted.' })).content[0].text);
    assert.equal(added.kind, 'text');
    await mcp.close();
    assert.equal((await viewer.del(`/api/attachments/${added.id}`)).status, 403);
    assert.equal((await analyst.del(`/api/attachments/${added.id}`)).status, 200);
    assert.equal((await raw(analyst, `/api/attachments/${added.id}`)).status, 404);
  });

  test('only the upload route reads raw bodies, within the configured size', async () => {
    const big = new Uint8Array(5 * 1024 * 1024);
    const login = await fetch(`${k.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: big });
    assert.ok([413, 415].includes(login.status), `sign-in refuses raw bodies (${login.status})`);
    const { query } = await import('../../src/db.js');
    await query(`UPDATE settings SET value = value || '{"max_file_mb": 1}' WHERE key = 'attachments'`);
    const tooBig = await upload(analyst, prb, 'big.log', Buffer.alloc(2 * 1024 * 1024, 'a'));
    assert.equal(tooBig.status, 413);
    await query(`UPDATE settings SET value = value || '{"max_file_mb": 10}' WHERE key = 'attachments'`);
    const sec = (await admin.get('/api/admin/security')).body.checks.find((c: any) => c.id === 'attachment_storage');
    assert.equal(sec.ok, true);
    assert.match(sec.detail, /included in every backup/);
  });

  test('attachments go with their record, and the audit trail holds no file names', async () => {
    const { query } = await import('../../src/db.js');
    const rows = (await query("SELECT changes FROM audit_log WHERE entity_type = 'attachment'")).rows;
    assert.ok(rows.length > 0 && !JSON.stringify(rows).includes('shot 1.jpg'));
    await query('DELETE FROM incidents WHERE ref = $1', [inc]);
    assert.equal((await query('SELECT count(*)::int AS n FROM attachments WHERE record_ref = $1', [inc])).rows[0].n, 0);
    assert.equal((await query('SELECT count(*)::int AS n FROM attachment_blobs b WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.id = b.attachment_id)')).rows[0].n, 0);
    void admin;
  });
});
