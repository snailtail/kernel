import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('approve or reject from email and chat (#48)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;
  let n: typeof import('../../src/notifications/notifications.js');
  let db: typeof import('../../src/core/db.js');
  const ids: Record<string, number> = {};
  let ci = '';

  /** The Approve link (path and query) in the latest approval email to `who` about `ref`. */
  const linkFor = async (who: string, ref: string) => {
    await n.processNotificationDeliveries(100);
    const mail = n.capturedMail.filter((m) => m.to === `${who}@example.com` && m.subject.includes(ref)).at(-1);
    assert.ok(mail, `an email to ${who} about ${ref}`);
    const url = mail.text.match(/Approve: (\S+)/)?.[1];
    assert.ok(url, mail.text);
    return url.slice(url.indexOf('/api/'));
  };
  const open = async (path: string, cookie?: Client) => {
    const res = await fetch(k.base + path, { headers: cookie?.cookie ? { Cookie: cookie.cookie } : {} });
    return { status: res.status, text: await res.text() };
  };
  /** Opens the page like a person and posts its form, as a browser would (Origin of the page). */
  const decide = async (path: string, decision: 'approve' | 'reject', comment = '', headers: Record<string, string> = {}) => {
    const page = await open(path);
    const form = page.text.match(/name="form" value="([^"]+)"/)?.[1] ?? '';
    const action = (page.text.match(/action="([^"]+)"/)?.[1] ?? path).replaceAll('&#38;', '&');
    const res = await fetch(k.base + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: k.base, ...headers },
      body: new URLSearchParams({ decision, comment, form }).toString(),
    });
    return { status: res.status, text: await res.text() };
  };
  const change = async (title: string, opts: { criticality?: number; change_type?: string; by?: Client } = {}) => {
    const by = opts.by ?? analyst;
    const target = opts.criticality ? (await pm.post('/api/cis', { name: `${title} box`, ci_type: 'other', criticality: opts.criticality })).body.ref : ci;
    const c = (await by.post('/api/changes', {
      title, cis: [target], change_type: opts.change_type ?? 'normal', implementation_plan: 'Patch', backout_plan: 'Unpatch',
      planned_start: new Date(Date.now() + 86400_000).toISOString(), planned_end: new Date(Date.now() + 90000_000).toISOString(),
    })).body;
    assert.ok(c.ref, JSON.stringify(c));
    await by.post(`/api/changes/${c.ref}/transition`, { to: 'assess' });
    const r = await by.post(`/api/changes/${c.ref}/transition`, { to: 'authorize' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return c.ref as string;
  };

  before(async () => {
    process.env.SMTP_URL = 'capture:';
    k = await startKernel();
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
    n = await import('../../src/notifications/notifications.js');
    db = await import('../../src/core/db.js');
    for (const u of (await admin.get('/api/users')).body) {
      ids[u.username] = u.id;
      await db.query('UPDATE users SET email = $2 WHERE id = $1', [u.id, `${u.username}@example.com`]);
    }
    ci = (await pm.post('/api/cis', { name: 'link-box', ci_type: 'other', criticality: 4 })).body.ref;
  });
  after(async () => {
    delete process.env.SMTP_URL;
    await k?.close();
  });

  test('GET changes nothing; the POST approves once, as the approver, and is audited as an email link', async () => {
    const ref = await change('Patch link-box');
    const link = await linkFor('admin', ref);
    assert.match(link, /^\/api\/public\/approval-links\?token=[\w-]{43}&decision=approve$/);
    for (let i = 0; i < 3; i++) {
      const page = await open(link); // a mail scanner, then the person
      assert.equal(page.status, 200);
      assert.match(page.text, new RegExp(`${ref}: Patch link-box`));
      assert.match(page.text, /value="approve" required checked/);
    }
    const before = (await admin.get(`/api/changes/${ref}`)).body;
    assert.deepEqual([before.status, before.votes.length], ['authorize', 0], 'opening the link decides nothing');
    // The link decides for its owner, whoever's browser posts it: a session cookie of someone else is ignored.
    const ok = await decide(link, 'approve', '', { Cookie: pm.cookie ?? '' });
    assert.equal(ok.status, 200, ok.text);
    assert.match(ok.text, new RegExp(`You approved ${ref}`));
    const after = (await admin.get(`/api/changes/${ref}`)).body;
    assert.equal(after.status, 'scheduled');
    assert.deepEqual(after.votes.map((v: any) => [v.user_id, v.decision]), [[ids.admin, 'approve']]);
    assert.ok(after.activity.some((a: any) => a.kind === 'vote' && a.channel === 'email_link'));
    const again = await decide(link, 'approve');
    assert.equal(again.status, 410, 'single use');
    assert.match(again.text, /already been used/);
    const trail = (await admin.get(`/api/audit?entity_ref=${ref}`)).body;
    const entry = trail.find((e: any) => e.action === 'decided_by_link');
    assert.ok(entry, 'the decision is audited');
    assert.equal(entry.channel, 'email_link');
    assert.equal(entry.actor_user_id, ids.admin);
    assert.equal(typeof entry.changes.link_id, 'number');
    assert.ok(!JSON.stringify(trail).includes(link.split('token=')[1].split('&')[0]), 'never the token');
  });

  test('rejecting needs a comment; the form token and the page origin are required', async () => {
    const ref = await change('Reboot link-box');
    const link = await linkFor('admin', ref);
    assert.equal((await decide(link, 'reject')).status, 400, 'no comment');
    const forged = await fetch(k.base + link, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: k.base }, body: 'decision=approve&form=x' });
    assert.equal(forged.status, 400, 'without the form token from the page');
    assert.equal((await decide(link, 'approve', '', { Origin: 'https://evil.example' })).status, 403, 'another origin');
    const noOrigin = await fetch(k.base + link, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'decision=approve&form=x' });
    assert.equal(noOrigin.status, 403, 'no origin');
    assert.equal((await admin.get(`/api/changes/${ref}`)).body.status, 'authorize', 'none of it decided anything');
    const ok = await decide(link, 'reject', 'Not during quarter close');
    assert.equal(ok.status, 200, ok.text);
    const c = (await admin.get(`/api/changes/${ref}`)).body;
    assert.equal(c.status, 'rejected');
    assert.equal(c.votes[0].comment, 'Not during quarter close');
  });

  test('a link stops working when it expires, when the request is decided elsewhere, or when the change changes', async () => {
    const expired = await change('Expire link-box');
    const e = await linkFor('admin', expired);
    await db.query("UPDATE approval_links SET expires_at = now() - interval '1 minute' WHERE token_hash = sha256(convert_to($1, 'UTF8'))", [e.split('token=')[1].split('&')[0]]);
    assert.match((await open(e)).text, /expired/);
    assert.equal((await decide(e, 'approve')).status, 410);

    const elsewhere = await change('Decided in the UI');
    const d = await linkFor('admin', elsewhere);
    assert.equal((await pm.post(`/api/changes/${elsewhere}/votes`, { decision: 'approve' })).status, 200);
    assert.match((await open(d)).text, /nothing left for you to decide/);
    assert.equal((await decide(d, 'approve')).status, 410);

    const changed = await change('Changed after sending');
    const c = await linkFor('admin', changed);
    await db.query("UPDATE changes SET backout_plan = 'Restore the snapshot' WHERE ref = $1", [changed]);
    const page = await open(c);
    assert.match(page.text, /has changed since the link was sent/);
    assert.match(page.text, new RegExp(`href="/changes/${changed}"`));
    assert.equal((await decide(c, 'approve')).status, 410);

    const cancelled = await change('Cancelled while waiting');
    const x = await linkFor('admin', cancelled);
    assert.equal((await analyst.post(`/api/changes/${cancelled}/transition`, { to: 'cancelled', cancel_reason: 'Vendor withdrew the patch' })).status, 200);
    assert.match((await open(x)).text, /nothing left for you to decide/);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM approval_links l JOIN changes c ON c.id = l.change_id WHERE c.ref = $1 AND l.revoked_at IS NULL', [cancelled]);
    assert.equal(rows[0].n, 0, 'leaving authorisation revokes the links');
  });

  test('emergency and high-risk changes need a signed-in approver', async () => {
    const high = await change('Core switch firmware', { criticality: 1 });
    await n.processNotificationDeliveries(100);
    const mail = n.capturedMail.filter((m) => m.to === 'admin@example.com' && m.subject.includes(high)).at(-1)!;
    assert.match(mail.text, /sign in to decide/);
    assert.doesNotMatch(mail.text, /Approve:/);
    // A link minted while the change was low risk asks for a sign-in once the risk is raised.
    const raised = await change('Raised later');
    const link = await linkFor('admin', raised);
    await db.query("UPDATE settings SET value = value || '{\"link_max_risk\": \"none\"}' WHERE key = 'change_policy'");
    await db.query("INSERT INTO settings (key, value) VALUES ('change_policy', '{\"link_max_risk\": \"none\"}') ON CONFLICT (key) DO NOTHING");
    const page = await open(link);
    assert.match(page.text, /Sign in to decide/);
    assert.equal((await decide(link, 'approve')).status, 410);
    assert.equal((await admin.get(`/api/changes/${raised}`)).body.status, 'authorize');
    await db.query("UPDATE settings SET value = value - 'link_max_risk' WHERE key = 'change_policy'");
  });

  test('an unknown or disabled account cannot use a link; chat messages carry the buttons', async () => {
    assert.equal((await open('/api/public/approval-links?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status, 410);
    const ref = await change('Disabled approver');
    const link = await linkFor('admin', ref);
    await db.query('UPDATE users SET active = false WHERE id = $1', [ids.admin]);
    const refused = await open(link);
    await db.query('UPDATE users SET active = true WHERE id = $1', [ids.admin]);
    assert.match(refused.text, /nothing left for you to decide/);
    const { formatBody } = await import('../../src/notifications/webhooks.js');
    const actions = [{ title: 'Approve', url: 'https://k/a' }, { title: 'Reject', url: 'https://k/r' }];
    const slack = formatBody('slack', { summary: 'Waits', problem: { ref, title: 'T', url: 'https://k/c' }, actions });
    assert.match(slack.text, /<https:\/\/k\/a\|Approve> · <https:\/\/k\/r\|Reject>/);
    const teams = formatBody('teams_workflow', { summary: 'Waits', problem: { ref, title: 'T', url: 'https://k/c' }, actions });
    assert.deepEqual(teams.attachments[0].content.actions.map((a: any) => a.title), ['Approve', 'Reject', 'Open in Kernel']);
  });

  test('an MCP request is decided through the link like in the web UI', async () => {
    const approvals = await import('../../src/changes/approvals.js');
    const p = (await analyst.post('/api/problems', { title: 'Stale duplicate' })).body;
    const { rows: u } = await db.query("SELECT id, username, display_name, email, role, preferences, false AS must_change_password, false AS mfa_enabled FROM users WHERE username = 'pm'");
    const req = await approvals.requestApproval(u[0], p.ref, 'close', { to: 'closed', closure_code: 'cancelled' }, 'Close the stale duplicate', 'yes close it');
    const link = await linkFor('admin', p.ref);
    assert.match((await open(link)).text, /Close the stale duplicate/);
    assert.equal((await admin.get(`/api/problems/${p.ref}`)).body.status !== 'closed', true);
    const ok = await decide(link, 'approve');
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await admin.get(`/api/problems/${p.ref}`)).body.status, 'closed');
    const { rows } = await db.query('SELECT status, decided_by FROM pending_approvals WHERE id = $1', [req.pending_approval]);
    assert.deepEqual([rows[0].status, rows[0].decided_by], ['approved', ids.admin]);
    assert.equal((await decide(link, 'approve')).status, 410);

    // Accepting a risk is decided signed in: the mail has no links.
    const risky = (await analyst.post('/api/problems', { title: 'Known risk to accept' })).body;
    await approvals.requestApproval(u[0], risky.ref, 'risk_decision', { risk_level: 3, decision: 'accept', review_date: '2099-06-01' }, 'Accept the risk until 2099', 'yes accept');
    await n.processNotificationDeliveries(100);
    const mail = n.capturedMail.filter((m) => m.to === 'admin@example.com' && m.subject.includes(risky.ref)).at(-1)!;
    assert.match(mail.text, /sign in to decide/);
    assert.doesNotMatch(mail.text, /Approve:/);
  });
});
