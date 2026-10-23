// The record-kind registry (#172): every registered kind is covered by masking, visibility, redaction and live
// updates, checked against the schema itself, so a new kind (or a new table of free text) cannot be forgotten.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, type Harness } from './harness.js';

describe('record kinds (#172)', { skip }, () => {
  let k: Harness;
  let columns: Map<string, Set<string>>;
  const has = (table: string, column: string) => !!columns.get(table)?.has(column);

  before(async () => {
    k = await startKernel();
    const { rows } = await ownerQuery("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'");
    columns = new Map();
    for (const r of rows) columns.set(r.table_name, (columns.get(r.table_name) ?? new Set()).add(r.column_name));
  });
  after(async () => {
    await k?.close();
  });

  test('every kind names a table, an activity log and a comment hook that exist', async () => {
    const { recordTypes } = await import('../../src/records.js');
    for (const t of recordTypes()) {
      assert.ok(has(t.table, 'id') && has(t.table, 'ref'), `${t.type}: ${t.table} has no id and ref`);
      if (t.activity) {
        for (const c of [t.activity.fk, 'user_id', 'kind', 'body', 'data', 'channel', 'created_at', ...(t.activity.columns ?? [])]) {
          assert.ok(has(t.activity.table, c), `${t.type}: ${t.activity.table}.${c} is missing`);
        }
      }
      assert.equal(typeof t.comment, 'function', `${t.type}: no comment hook`);
    }
  });

  test('a kind whose table can be confidential is masked, restricted, redacted and marked for personal data', async () => {
    const { recordTypes, textKinds } = await import('../../src/records.js');
    const text = new Set(textKinds().map((t) => t.type));
    for (const t of recordTypes()) {
      // A review is masked through its incident (confidential.ts), so only kinds with a table of their own count.
      assert.equal(text.has(t.type), has(t.table, 'classification'), `${t.type}: ${t.table}.classification and people/textPlaces must come together`);
      if (!text.has(t.type)) continue;
      for (const c of ['restricted', 'restricted_teams', 'contains_personal_data', 'created_by']) assert.ok(has(t.table, c), `${t.type}: ${t.table}.${c} is missing`);
      for (const c of [t.people!.assignee, t.people!.team].filter(Boolean) as string[]) assert.ok(has(t.table, c), `${t.type}: ${t.table}.${c} is missing`);
    }
  });

  test('the masking SQL is valid for every kind that can be confidential', async () => {
    const { textKinds } = await import('../../src/records.js');
    const { textFilterSql } = await import('../../src/confidential.js');
    for (const t of textKinds()) {
      const params: unknown[] = [];
      const where = textFilterSql('a', t.type, 'word', params);
      await ownerQuery(`SELECT count(*) FROM ${t.table} a WHERE ${where}`, params);
    }
  });

  test('redaction reaches every masked field and every place the kind names', async () => {
    const { textKinds } = await import('../../src/records.js');
    const { MASKED_FIELDS } = await import('../../src/confidential.js');
    for (const t of textKinds()) {
      for (const p of t.textPlaces) {
        for (const c of [p.key, ...p.columns, ...(p.json ?? [])]) assert.ok(has(p.table, c), `${t.type}: ${p.table}.${c} is missing`);
      }
      const own = t.textPlaces.filter((p) => p.table === t.table).flatMap((p) => [...p.columns, ...(p.json ?? [])]);
      for (const c of columns.get(t.table) ?? []) {
        if (MASKED_FIELDS.has(c)) assert.ok(own.includes(c), `${t.type}: ${t.table}.${c} is masked but never redacted`);
      }
      assert.ok(t.activity && t.textPlaces.some((p) => p.table === t.activity!.table), `${t.type}: its history is not redacted`);
    }
  });

  test('restricting checks the kind in the database too (row-level security and record lookup)', async () => {
    const { textKinds } = await import('../../src/records.js');
    const { rows: policies } = await ownerQuery("SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'");
    const { rows: lookup } = await ownerQuery("SELECT prosrc FROM pg_proc WHERE proname = 'kernel_record_lookup'");
    for (const t of textKinds()) {
      assert.ok(policies.some((p) => p.tablename === t.table), `${t.type}: ${t.table} has no row-level security policy`);
      assert.match(lookup[0].prosrc, new RegExp(`\\b${t.table}\\b`), `${t.type}: kernel_record_lookup does not know ${t.table}`);
    }
  });

  test('every live trigger on a record table is a registered topic, and every topic has its trigger', async () => {
    const { recordTypes } = await import('../../src/records.js');
    const { rows } = await ownerQuery(
      `SELECT c.relname AS table, pg_get_triggerdef(g.oid) AS def FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
       WHERE NOT g.tgisinternal AND pg_get_triggerdef(g.oid) LIKE '%kernel_live_notify(%'`,
    );
    const onRecords = rows.map((r) => ({ table: r.table as string, m: /kernel_live_notify\('(\w+)', 'id'\)/.exec(r.def) })).filter((r) => r.m);
    assert.ok(onRecords.length > 0);
    for (const { table, m } of onRecords) {
      assert.ok(recordTypes().some((t) => t.liveTopic === m![1] && t.table === table), `${table} sends "${m![1]}" but no record type has that live topic`);
    }
    for (const t of recordTypes().filter((x) => x.liveTopic)) {
      assert.ok(onRecords.some((r) => r.table === t.table && r.m![1] === t.liveTopic), `${t.type}: ${t.table} has no live trigger for "${t.liveTopic}"`);
    }
  });
});
