import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { skip, startKernel, type Client, type Harness } from './harness.js';

/** A minimal EventSource for tests: collects events from GET /api/live. */
class Stream {
  events: { event: string; data: any }[] = [];
  comments = 0;
  ended = false;
  status = 0;
  private ctrl = new AbortController();
  private waiters: (() => void)[] = [];
  static async open(base: string, headers: Record<string, string>) {
    const s = new Stream();
    const res = await fetch(`${base}/api/live`, { headers, signal: s.ctrl.signal });
    s.status = res.status;
    if (res.ok && res.body) void s.read(res.body);
    else s.ended = true;
    return s;
  }
  private async read(body: ReadableStream<Uint8Array>) {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of body as any) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(':')) this.comments++;
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev) this.events.push({ event: ev, data: data ? JSON.parse(data) : null });
          this.waiters.splice(0).forEach((w) => w());
        }
      }
    } catch {
      // aborted
    }
    this.ended = true;
    this.waiters.splice(0).forEach((w) => w());
  }
  async waitFor(pred: () => boolean, ms = 3000) {
    const until = Date.now() + ms;
    while (!pred() && Date.now() < until) await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 100); });
    return pred();
  }
  get id() { return this.events.find((e) => e.event === 'hello')?.data.stream as string; }
  changes(kind: string, id: number) { return this.events.filter((e) => e.event === 'change' && e.data.kind === kind && e.data.id === id).length; }
  close() { this.ctrl.abort(); }
}

/** Setup calls must succeed: a refused setup would make a test of absence pass for the wrong reason. */
const ok = (r: { status: number; body: unknown }) => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);

describe('live updates (#70)', { skip }, () => {
  let k: Harness;
  let analyst: Client, analyst2: Client, viewer: Client, pm: Client, admin: Client;
  let live: typeof import('../../src/live.js');
  const open: Stream[] = [];
  const stream = async (c: Client) => {
    const s = await Stream.open(k.base, { Cookie: c.cookie! });
    open.push(s);
    await s.waitFor(() => !!s.id);
    return s;
  };

  before(async () => {
    k = await startKernel();
    [analyst, analyst2, viewer, pm, admin] = await Promise.all([k.login('analyst'), k.login('analyst2'), k.login('viewer'), k.login('pm'), k.login('admin')]);
    live = await import('../../src/live.js');
  });
  after(async () => {
    for (const s of open) s.close();
    await k?.close();
  });

  test('a change reaches those following the record or the list, after commit, as kind and id only', async () => {
    const p = (await analyst.post('/api/problems', { title: 'Live problem' })).body;
    const a = await stream(analyst);
    const b = await stream(viewer);
    assert.equal((await analyst.put(`/api/live/${a.id}`, { topics: [`problem:${p.id}`] })).status, 200);
    assert.equal((await viewer.put(`/api/live/${b.id}`, { topics: ['problem:*'] })).status, 200);
    ok(await pm.post(`/api/problems/${p.ref}/comments`, { body: 'Seen live' }));
    assert.ok(await a.waitFor(() => a.changes('problem', p.id) > 0), 'the record page hears about the comment');
    assert.ok(await b.waitFor(() => b.changes('problem', p.id) > 0), 'the list hears about it too');
    const ev = a.events.find((e) => e.event === 'change')!;
    assert.deepEqual(Object.keys(ev.data).sort(), ['id', 'kind'], 'no field values, no names');
    // Someone else's stream cannot be steered.
    assert.equal((await viewer.put(`/api/live/${a.id}`, { topics: ['problem:*'] })).status, 404);
  });

  test('nobody hears about a restricted record they cannot see, not even that it changed', async () => {
    const sec = (await admin.post('/api/teams', { name: 'Live security' })).body;
    const ids = Object.fromEntries((await admin.get('/api/users')).body.map((u: any) => [u.username, u.id]));
    assert.equal((await admin.put(`/api/teams/${sec.id}/members`, { members: [{ user_id: ids.analyst, role: 'lead' }] })).status, 200);
    const p = (await analyst.post('/api/problems', { title: 'Secret live problem' })).body;
    const open = (await analyst.post('/api/problems', { title: 'Ordinary live problem' })).body;
    assert.equal((await analyst.put(`/api/records/${p.ref}/visibility`, { restricted: true, teams: [sec.id], reason: 'Security investigation' })).status, 200);
    const a = await stream(analyst);
    const b = await stream(viewer);
    assert.equal((await analyst.put(`/api/live/${a.id}`, { topics: ['problem:*', `problem:${p.id}`] })).status, 200);
    const sub = (await viewer.put(`/api/live/${b.id}`, { topics: ['problem:*', `problem:${p.id}`] })).body;
    assert.deepEqual(sub.topics, ['problem:*'], 'a record topic the user cannot see is dropped');
    ok(await analyst.post(`/api/problems/${p.ref}/comments`, { body: 'Only for the team' }));
    ok(await analyst.post(`/api/problems/${open.ref}/comments`, { body: 'For everyone' }));
    assert.ok(await a.waitFor(() => a.changes('problem', p.id) > 0), 'the team member hears about the restricted record');
    // Positive control: the same list stream does receive changes it may see, in the same window.
    assert.ok(await b.waitFor(() => b.changes('problem', open.id) > 0), 'the viewer\'s stream works');
    assert.equal(b.changes('problem', p.id), 0, 'the list follower never learns the restricted record exists');
  });

  test('presence: who else has the record open, only for those who can see it, and opt-out', async () => {
    const p = (await pm.post('/api/problems', { title: 'Presence problem' })).body;
    const a = await stream(analyst);
    const m = await stream(pm);
    assert.equal((await analyst.put(`/api/live/${a.id}`, { topics: [`problem:${p.id}`] })).status, 200);
    assert.equal((await pm.put(`/api/live/${m.id}`, { topics: [`problem:${p.id}`], editing: `problem:${p.id}` })).status, 200);
    const seen = () => a.events.filter((e) => e.event === 'presence' && e.data.topic === `problem:${p.id}`).at(-1)?.data.people ?? [];
    assert.ok(await a.waitFor(() => seen().some((x: any) => x.editing)), JSON.stringify(a.events));
    assert.equal(seen().length, 1);
    // Opting out: the manager disappears from others' view on the next subscription.
    assert.equal((await pm.put('/api/auth/preferences', { live_presence: false })).status, 200);
    const m2 = await stream(pm);
    m.close();
    await pm.put(`/api/live/${m2.id}`, { topics: [`problem:${p.id}`] });
    assert.ok(await a.waitFor(() => seen().length === 0));
    await pm.put('/api/auth/preferences', { live_presence: true });
  });

  test('restricting a record or leaving its team stops following it at once, presence included', async () => {
    const team = (await admin.post('/api/teams', { name: 'Live inner circle' })).body;
    const ids = Object.fromEntries((await admin.get('/api/users')).body.map((u: any) => [u.username, u.id]));
    assert.equal((await admin.put(`/api/teams/${team.id}/members`, { members: [{ user_id: ids.analyst, role: 'lead' }, { user_id: ids.analyst2, role: 'member' }] })).status, 200);
    const p = (await analyst.post('/api/problems', { title: 'Soon restricted' })).body;
    const a = await stream(analyst);
    const b = await stream(analyst2);
    await analyst.put(`/api/live/${a.id}`, { topics: [`problem:${p.id}`] });
    await analyst2.put(`/api/live/${b.id}`, { topics: [`problem:${p.id}`] });
    const seenByA = () => a.events.filter((e) => e.event === 'presence' && e.data.topic === `problem:${p.id}`).at(-1)?.data.people ?? [];
    assert.ok(await a.waitFor(() => seenByA().length === 1), 'the analyst sees the colleague');

    // Restricted to the team (the colleague is in it): still visible to both.
    await analyst.put(`/api/records/${p.ref}/visibility`, { restricted: true, teams: [team.id], reason: 'Security investigation' });
    assert.ok(await b.waitFor(() => b.changes('problem', p.id) > 0), 'a team member still hears about it');
    // The colleague leaves the team: their stream drops the record without waiting for the minute's re-check.
    assert.equal((await admin.put(`/api/teams/${team.id}/members`, { members: [{ user_id: ids.analyst, role: 'lead' }] })).status, 200);
    assert.ok(await a.waitFor(() => seenByA().length === 0), 'the colleague no longer shows as present');
    const before = b.changes('problem', p.id);
    ok(await analyst.post(`/api/problems/${p.ref}/comments`, { body: 'After the colleague left' }));
    assert.ok(await a.waitFor(() => a.changes('problem', p.id) > 0));
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(b.changes('problem', p.id), before, 'nothing more reaches the former member');
  });

  test('signing out closes the stream; tokens and too many streams are refused', async () => {
    const extra = await k.login('analyst');
    const s = await stream(extra);
    await extra.post('/api/auth/logout');
    await live.recheckAll();
    assert.ok(await s.waitFor(() => s.ended), 'a revoked session loses its stream');
    assert.ok(s.events.some((e) => e.event === 'closed'));

    const token = await k.tokenFor('analyst');
    const viaToken = await Stream.open(k.base, { Authorization: `Bearer ${token}` });
    assert.equal(viaToken.status, 403, 'agents and scripts use webhooks');

    const before = live.liveStats().streams;
    const many: Stream[] = [];
    for (let i = 0; i < live.LIMITS.perUser + 2; i++) many.push(await stream(viewer));
    const mine = many.filter((x) => !x.ended);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(many.filter((x) => !x.ended).length <= live.LIMITS.perUser, 'the oldest streams give way');
    assert.ok(live.liveStats().streams <= before + live.LIMITS.perUser);
    assert.ok(mine.length > 0);
  });

  test('a heartbeat keeps the connection open through proxies', async () => {
    const s = await stream(analyst);
    live.heartbeatNow();
    assert.ok(await s.waitFor(() => s.comments > 0));
  });
});
