import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { skip, startKernel, TEST_DATABASE_URL, type Harness } from './harness.js';

describe('least-privilege database role and audit anchors', { skip }, () => {
  let k: Harness;
  let app: pg.Client;

  before(async () => {
    k = await startKernel();
    const { ensureAppRole } = await import('../../src/db.js');
    const owner = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await owner.connect();
    await ensureAppRole(owner, 'kernel_test_app', 'test-app-password-123');
    await owner.end();
    const url = new URL(TEST_DATABASE_URL!);
    url.username = 'kernel_test_app';
    url.password = 'test-app-password-123';
    app = new pg.Client({ connectionString: url.toString() });
    await app.connect();
  });
  after(async () => {
    await app?.end();
    await k?.close();
  });

  test('the runtime role works with data', async () => {
    await app.query("INSERT INTO categories (name) VALUES ('Role test')");
    assert.equal((await app.query("SELECT count(*)::int AS n FROM categories WHERE name = 'Role test'")).rows[0].n, 1);
    await app.query("INSERT INTO audit_log (actor_type, entity_type, action, prev_hash, hash) VALUES ('system', 'test', 'insert', 'x', 'y')");
  });

  test('the runtime role cannot rewrite the audit trail or the schema', async () => {
    for (const sql of [
      "UPDATE audit_log SET reason = 'x'",
      'DELETE FROM audit_log',
      'TRUNCATE audit_log',
      'ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update',
      'DROP TRIGGER audit_log_no_update ON audit_log',
      'CREATE TABLE sneaky (id int)',
      "DELETE FROM schema_migrations",
    ]) {
      await assert.rejects(app.query(sql), /permission denied|must be owner|append-only/, sql);
    }
  });

  test('audit anchors are only emitted for committed changes', async () => {
    const { audit, setAnchorSink } = await import('../../src/audit.js');
    const { tx } = await import('../../src/db.js');
    const anchors: number[] = [];
    setAnchorSink((a) => anchors.push(a.id));
    try {
      await assert.rejects(
        tx(async (db) => {
          await audit(db, { entity_type: 'test', action: 'rolled_back' });
          throw new Error('fail after audit');
        }),
      );
      assert.deepEqual(anchors, [], 'no anchor for a rolled-back entry');
      await audit(null, { entity_type: 'test', action: 'committed' });
      assert.equal(anchors.length, 1);
    } finally {
      setAnchorSink(() => {});
    }
  });
});
