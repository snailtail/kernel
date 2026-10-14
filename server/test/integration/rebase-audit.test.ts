import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

const KEY = 'rebase-test-key-0123456789abcdefghijklmnop';
const NAME = 'Karin Lindqvist';
const EMAIL = 'karin.lindqvist@example.com';
const IP = '203.0.113.77';
const AWS = 'AKIAIOSFODNN7EXAMPLE';

describe('re-basing legacy audit entries (ADR 0001)', { skip }, () => {
  let k: Harness;
  let pm: Client;
  let audit: typeof import('../../src/audit.js');
  let rebase: typeof import('../../src/rebase-audit.js');
  const leftovers = async () =>
    Number((await ownerQuery('SELECT count(*) AS n FROM audit_log l WHERE l::text ~* $1', [[NAME, EMAIL, IP, AWS].map((s) => s.replace(/[.]/g, '\\.')).join('|')])).rows[0].n);

  before(async () => {
    process.env.KERNEL_SECRET_KEY = KEY;
    k = await startKernel();
    pm = await k.login('pm');
    [audit, rebase] = await Promise.all([import('../../src/audit.js'), import('../../src/rebase-audit.js')]);
    // A fresh trail: legacy entries as they were written before the privacy rules, then current ones.
    await ownerQuery('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_truncate');
    await ownerQuery('TRUNCATE audit_log, audit_context');
    await ownerQuery('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_truncate');
    let prev = audit.GENESIS;
    const legacy = [
      { version: 1, actor_name: NAME, ip: IP, user_agent: 'Mozilla/5.0', entity_type: 'user', entity_ref: 'pm', action: 'update', changes: { email: { from: EMAIL, to: 'x@example.com' } }, reason: `Asked by ${EMAIL}` },
      { version: 2, actor_name: NAME, ip: IP, user_agent: '', entity_type: 'problem', entity_ref: 'PRB000001', action: 'update', changes: { description: { from: 'free text about the outage', to: 'more text' }, external_id: AWS }, reason: '' },
      { version: 2, actor_name: 'system', ip: '', user_agent: '', entity_type: 'connector', entity_ref: 'vc1', action: 'run', changes: { api_key: AWS, status: 'ok' }, reason: '' },
    ];
    for (const e of legacy) {
      const row = { at: new Date().toISOString(), actor_user_id: null, actor_name: e.actor_name, actor_type: 'user', channel: 'web', token_prefix: '', ip: e.ip, request_id: '', entity_type: e.entity_type, entity_ref: e.entity_ref, action: e.action, changes: e.changes, reason: e.reason };
      const hash = audit.hashOf(prev, row, e.version);
      await ownerQuery(
        `INSERT INTO audit_log (at, actor_user_id, actor_name, actor_type, channel, token_prefix, ip, user_agent, request_id, entity_type, entity_ref, action, changes, reason, prev_hash, hash, hash_version)
         VALUES ($1, NULL, $2, 'user', 'web', '', $3, $4, '', $5, $6, $7, $8, $9, $10, $11, $12)`,
        [row.at, e.actor_name, e.ip, e.user_agent, e.entity_type, e.entity_ref, e.action, JSON.stringify(e.changes), e.reason, prev, hash, e.version],
      );
      prev = hash;
    }
    // Current entries on top.
    assert.equal((await pm.post('/api/problems', { title: 'After the rules' })).status, 201);
  });
  after(async () => {
    delete process.env.KERNEL_SECRET_KEY;
    await k?.close();
  });

  test('positive control: the legacy chain verifies and holds the personal data', async () => {
    assert.equal((await audit.verifyChain()).ok, true);
    assert.ok((await leftovers()) >= 2);
  });

  test('a dry run reports per field, with entry ids only, and changes nothing', async () => {
    const headBefore = (await ownerQuery('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1')).rows[0];
    const lines: string[] = [];
    const r = await rebase.runRebase(false, (m) => lines.push(m));
    assert.equal(r.rows_rewritten, 3, JSON.stringify(r));
    assert.ok(r.fields.actor_name >= 2 && r.fields.changes >= 2 && r.fields.reason === 1 && r.fields.entity_ref === 1, JSON.stringify(r.fields));
    assert.equal(r.moved_context, 2);
    assert.ok(!lines.join('\n').includes(NAME) && !lines.join('\n').includes(EMAIL), 'the report holds no values');
    assert.deepEqual((await ownerQuery('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1')).rows[0], headBefore);
    assert.ok((await leftovers()) >= 2, 'nothing was rewritten');
  });

  test('executing rewrites the legacy entries, keeps every entry, and the chain verifies with the active key', async () => {
    const countBefore = Number((await ownerQuery('SELECT count(*) AS n FROM audit_log')).rows[0].n);
    const oldHead = (await ownerQuery('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1')).rows[0];
    const r = await rebase.runRebase(true, () => {});
    assert.equal(r.rows_rewritten, 3);
    assert.equal(await leftovers(), 0, 'no names, emails, IP addresses or secrets remain');
    const countAfter = Number((await ownerQuery('SELECT count(*) AS n FROM audit_log')).rows[0].n);
    assert.equal(countAfter, countBefore + 2, 'every entry kept, plus the intent and the result');
    const v = await audit.verifyChain();
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(Number((await ownerQuery("SELECT count(*) AS n FROM audit_log WHERE hash_version <> 3 OR key_id IS DISTINCT FROM 'k0'")).rows[0].n), 0);
    // IP addresses moved to audit_context, under its retention.
    assert.equal((await ownerQuery('SELECT ip FROM audit_context WHERE ip = $1', [IP])).rows.length, 2);
    // The user ref became the account id; the field names and statuses stay readable.
    const first = (await ownerQuery('SELECT entity_ref, changes, reason FROM audit_log ORDER BY id LIMIT 1')).rows[0];
    assert.match(first.entity_ref, /^#\d+$/);
    assert.ok(first.changes.email.from.digest, 'personal values became digests');
    assert.match(first.reason, /\[REDACTED:email\]/);
    const connector = (await ownerQuery("SELECT changes FROM audit_log WHERE entity_type = 'connector'")).rows[0].changes;
    assert.equal(connector.api_key, '[changed]');
    assert.equal(connector.status, 'ok');
    // Bracketed in the trail itself: intent before, result after.
    const intent = (await ownerQuery("SELECT changes FROM audit_log WHERE action = 'chain_rebase_intent'")).rows[0].changes;
    assert.equal(intent.head.id, String(oldHead.id));
    assert.equal(intent.head.hash, oldHead.hash);
    const done = (await ownerQuery("SELECT changes FROM audit_log WHERE action = 'chain_rebased'")).rows[0].changes;
    assert.equal(done.rows_rewritten, 3);
    assert.equal(done.key_id, 'k0');
    assert.ok(done.old_head.hash && done.new_head.hash && done.old_head.hash !== done.new_head.hash);
  });

  test('a chain that does not verify inside the transaction is rolled back', async () => {
    const { withOwner } = await import('../../src/db.js');
    const before = (await ownerQuery('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1')).rows[0];
    // Something goes wrong between the rewrite and the commit: one rewritten hash is off.
    const err = await withOwner((c) => rebase.rebaseAudit(c, {
      execute: true,
      beforeVerify: async (o) => {
        await o.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
        await o.query("UPDATE audit_log SET hash = repeat('0', 64) WHERE id = (SELECT id FROM audit_log ORDER BY id LIMIT 1 OFFSET 1)");
      },
    })).catch((e) => e);
    assert.ok(err instanceof Error && /nothing was changed/.test(err.message), String(err));
    assert.deepEqual((await ownerQuery('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1')).rows[0], before, 'rolled back');
    assert.equal((await audit.verifyChain()).ok, true, 'the trail is as it was');
    assert.equal((await ownerQuery("SELECT tgenabled FROM pg_trigger WHERE tgname = 'audit_log_no_update'")).rows[0].tgenabled, 'O', 'the append-only trigger is on');
  });

  test('running it again changes nothing', async () => {
    const r = await rebase.runRebase(false, () => {});
    assert.equal(r.rows_rewritten, 0, JSON.stringify(r.fields));
  });
});
