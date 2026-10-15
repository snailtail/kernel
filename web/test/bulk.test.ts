import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyUndo, previewUndo, runBulk, storms, type BulkResult, type Post } from '../src/bulk.js';

const reply = (ids: string[], extra: Partial<BulkResult> = {}): BulkResult => ({
  summary: { changed: ids.length },
  results: ids.map((id) => ({ id, outcome: 'changed' })),
  pages: [],
  undo: { items: ids.map((id) => ({ id, operation: { op: 'assign', team_id: 1 } })) },
  ...extra,
});

test('a chunk that fails keeps what the earlier chunks did, and their undo (#110)', async () => {
  const ids = Array.from({ length: 120 }, (_, n) => `INC${n}`);
  const calls: any[] = [];
  const post: Post = async <T,>(_path: string, body: any) => {
    calls.push(body);
    if (calls.length === 2) throw new Error('Bad gateway');
    return reply(body.ids) as T;
  };
  const r = await runBulk(post, 'incidents', { ids }, { operation: { op: 'assign', team_id: 2 } });
  assert.equal(calls.length, 2, 'stops at the failing chunk');
  assert.equal(r.error, 'Bad gateway');
  assert.equal(r.sent, 50, 'applied to 50 of 120');
  assert.equal(r.summary.changed, 50);
  assert.equal(r.undo?.items.length, 50, 'the applied part can still be undone');
});

test('undo asks before paging a team more than once; it never confirms on its own', async () => {
  const undo = { items: ['INC1', 'INC2', 'INC3'].map((id) => ({ id, operation: { op: 'assign' as const, team_id: 7 } })) };
  const sent: any[] = [];
  const post: Post = async <T,>(_path: string, body: any) => {
    sent.push(body);
    if (body.dry_run) return reply([], { summary: { would_change: 3 }, pages: [{ team: 'Network', count: 3 }] }) as T;
    if (!body.confirm_paging) throw Object.assign(new Error('This would page Network 3 times; confirm with confirm_paging'), { status: 409 });
    return reply(body.items.map((i: any) => i.id)) as T;
  };
  const pages = await previewUndo(post, 'incidents', undo);
  assert.deepEqual(storms(pages), [{ team: 'Network', count: 3 }]);
  assert.ok(sent.every((b) => b.dry_run && !b.confirm_paging), 'the check is a dry run without confirmation');

  const refused = await applyUndo(post, 'incidents', undo, false);
  assert.match(refused.error ?? '', /page Network 3 times/, 'without the person confirming, the server refuses');
  const done = await applyUndo(post, 'incidents', undo, true);
  assert.equal(done.summary.changed, 3);
  assert.equal(sent.at(-1).confirm_paging, true, 'confirmation only after the person ticked it');
});

test('one page per team needs no confirmation', () => {
  assert.deepEqual(storms([{ team: 'A', count: 1 }, { team: 'B', count: 2 }]), [{ team: 'B', count: 2 }]);
});
