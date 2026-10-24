import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, type Harness } from './harness.js';

describe('the shared outbox (#173)', { skip }, () => {
  let k: Harness;
  let db: typeof import('../../src/core/db.js');
  let outbox: typeof import('../../src/core/outbox.js');
  const sentTo: string[] = [];
  let failing = new Set<string>();

  const box = (extra: Partial<import('../../src/core/outbox.js').Outbox<any>> = {}) => ({
    table: 'outbox_probe', leaseSeconds: 60, limit: 10, retryIn: outbox.backoffMinutes(1, 5), permanent: /not configured/,
    send: async (row: any) => {
      if (row.target === 'nobody') return 'skipped' as const;
      if (row.target === 'gone') throw new outbox.SkipDelivery('Nobody to send to');
      if (failing.has(row.target)) throw new Error(row.target === 'unconfigured' ? 'Mail is not configured' : 'Connection refused');
      sentTo.push(row.target);
    },
    ...extra,
  });
  const row = async (target: string) => (await db.query('SELECT * FROM outbox_probe WHERE target = $1', [target])).rows[0];
  const add = (target: string) => db.query('INSERT INTO outbox_probe (target) VALUES ($1)', [target]);

  before(async () => {
    k = await startKernel();
    db = await import('../../src/core/db.js');
    outbox = await import('../../src/core/outbox.js');
    // A table of its own, made by the owner as migrations are, for the app role to work on.
    await ownerQuery(`CREATE TABLE outbox_probe (id bigserial PRIMARY KEY, target text NOT NULL, status text NOT NULL DEFAULT 'pending',
      attempts int NOT NULL DEFAULT 0, error text NOT NULL DEFAULT '', lease_until timestamptz, sent_at timestamptz,
      next_attempt_at timestamptz NOT NULL DEFAULT now());
      GRANT ALL ON outbox_probe, outbox_probe_id_seq TO ${process.env.KERNEL_APP_DB_USER}`);
  });
  after(async () => {
    await ownerQuery('DROP TABLE IF EXISTS outbox_probe');
    await k?.close();
  });

  test('sends, skips and records the outcome', async () => {
    await add('a');
    await add('nobody');
    await add('gone');
    assert.deepEqual(await outbox.processOutbox(box()), { claimed: 3, sent: 1 });
    assert.deepEqual(sentTo, ['a']);
    const a = await row('a');
    assert.equal(a.status, 'sent');
    assert.equal(a.attempts, 1);
    assert.ok(a.sent_at);
    assert.equal(a.lease_until, null);
    assert.equal((await row('nobody')).status, 'skipped');
    const gone = await row('gone');
    assert.equal(gone.status, 'skipped');
    assert.equal(gone.error, 'Nobody to send to');
    assert.equal(gone.sent_at, null);
    // Nothing is due any more.
    assert.deepEqual(await outbox.processOutbox(box()), { claimed: 0, sent: 0 });
  });

  test('a failure is retried with backoff, then fails; a permanent error fails at once', async () => {
    failing = new Set(['b', 'unconfigured']);
    await add('b');
    await add('unconfigured');
    await outbox.processOutbox(box());
    let b = await row('b');
    assert.equal(b.status, 'pending');
    assert.equal(b.error, 'Connection refused');
    const wait = (new Date(b.next_attempt_at).getTime() - Date.now()) / 1000;
    assert.ok(wait > 50 && wait <= 60, `retried in ${wait} s`);
    const unconfigured = await row('unconfigured');
    assert.equal(unconfigured.status, 'failed');
    assert.equal(unconfigured.attempts, 1);
    // Not due yet; made due, it waits five minutes; after the last step it gives up.
    assert.equal((await outbox.processOutbox(box())).claimed, 0);
    await db.query("UPDATE outbox_probe SET next_attempt_at = now() WHERE target = 'b'");
    await outbox.processOutbox(box());
    b = await row('b');
    assert.equal(b.attempts, 2);
    assert.ok((new Date(b.next_attempt_at).getTime() - Date.now()) / 1000 > 290);
    await db.query("UPDATE outbox_probe SET next_attempt_at = now() WHERE target = 'b'");
    await outbox.processOutbox(box());
    b = await row('b');
    assert.equal(b.status, 'failed');
    assert.equal(b.attempts, 3);
    // Once it works again, a successful send clears the error.
    failing = new Set();
    await db.query("UPDATE outbox_probe SET status = 'pending', next_attempt_at = now() WHERE target = 'b'");
    await outbox.processOutbox(box());
    b = await row('b');
    assert.equal(b.status, 'sent');
    assert.equal(b.error, '');
  });

  test('a lease that ran out is taken again; a live lease is not', async () => {
    await add('c');
    await db.query("UPDATE outbox_probe SET status = 'sending', lease_until = now() + interval '1 minute' WHERE target = 'c'");
    assert.equal((await outbox.processOutbox(box())).claimed, 0);
    await db.query("UPDATE outbox_probe SET lease_until = now() - interval '1 second' WHERE target = 'c'");
    assert.equal((await outbox.processOutbox(box())).sent, 1);
    assert.equal((await row('c')).status, 'sent');
  });

  test('two claims at the same time never send a row twice', async () => {
    sentTo.length = 0;
    for (let i = 0; i < 20; i++) await add(`p${i}`);
    // A slow send keeps the first claim's rows leased while the second claim runs.
    const slow = box({ limit: 15, send: async (r: any) => { await new Promise((ok) => setTimeout(ok, 20)); sentTo.push(r.target); } });
    const [x, y] = await Promise.all([outbox.processOutbox(slow), outbox.processOutbox(slow)]);
    assert.equal(x.claimed + y.claimed, 20);
    assert.equal(sentTo.length, 20);
    assert.equal(new Set(sentTo).size, 20);
  });

  test('mapped columns and extra columns (webhooks)', async () => {
    await ownerQuery('ALTER TABLE outbox_probe RENAME COLUMN lease_until TO locked_until');
    await ownerQuery('ALTER TABLE outbox_probe ALTER COLUMN error DROP NOT NULL');
    await ownerQuery('ALTER TABLE outbox_probe ADD COLUMN response_status int');
    await add('d');
    const mapped = box({
      columns: { lease: 'locked_until', sent: 'ok', noError: null },
      filter: { sql: 'target = $2', params: ['d'] },
      send: async (_r: any, extra: Record<string, unknown>) => { extra.response_status = 204; },
    });
    assert.deepEqual(await outbox.processOutbox(mapped), { claimed: 1, sent: 1 });
    const d = await row('d');
    assert.equal(d.status, 'ok');
    assert.equal(d.error, null);
    assert.equal(d.response_status, 204);
    assert.equal(d.locked_until, null);
    // GiveUp fails at once, whatever the backoff says.
    await add('e');
    await outbox.processOutbox(box({ columns: { lease: 'locked_until' }, send: async () => { throw new outbox.GiveUp('No longer open'); } }));
    assert.equal((await row('e')).status, 'failed');
  });
});
