// Talking to POST /api/<practice>/bulk (#110): chunks, totals, partial failures and undo. No React here, so the
// rules are tested on their own (test/bulk.test.ts); the list toolkit renders them.

export type Practice = 'incidents' | 'problems' | 'changes' | 'alerts' | 'actions' | 'articles' | 'cis';
export type OpName = 'assign' | 'status' | 'priority' | 'tags' | 'link_problem' | 'set_parent' | 'acknowledge' | 'close';
export type Operation = { op: OpName } & Record<string, unknown>;
export interface ItemResult { id: string; title?: string; outcome: 'changed' | 'would_change' | 'unchanged' | 'skipped' | 'failed'; reason?: string }
export type UndoItems = { items: { id: string; operation: Operation }[] };
export interface BulkResult {
  summary: Record<string, number>;
  results: ItemResult[];
  pages: { team: string; count: number }[];
  undo: UndoItems | null;
  /** Set when a chunk failed: what stopped it, and how many records were sent before (those stay applied). */
  error?: string;
  sent?: number;
}

export type Post = <T>(path: string, body: unknown) => Promise<T>;

export const CHUNK = 50;

/**
 * Sends ids (or undo items) in chunks of 50, so a big selection shows progress and each request stays well within
 * proxy limits. A failing chunk stops the run; what the earlier chunks did, and their undo, is kept and returned
 * with the error, so the person sees "applied to X of Y" and can still undo it.
 */
export async function runBulk(post: Post, practice: Practice, entries: { ids: string[] } | UndoItems, body: object, onProgress?: (done: number) => void): Promise<BulkResult> {
  const list: unknown[] = 'ids' in entries ? entries.ids : entries.items;
  const key = 'ids' in entries ? 'ids' : 'items';
  const total: BulkResult = { summary: {}, results: [], pages: [], undo: { items: [] } };
  let undoable = true;
  for (let i = 0; i < list.length; i += CHUNK) {
    let r: BulkResult;
    try {
      r = await post<BulkResult>(`/api/${practice}/bulk`, { ...body, [key]: list.slice(i, i + CHUNK) });
    } catch (err) {
      total.error = (err as Error).message;
      total.sent = i;
      break;
    }
    for (const [k, v] of Object.entries(r.summary)) total.summary[k] = (total.summary[k] ?? 0) + v;
    total.results.push(...r.results);
    for (const p of r.pages) {
      const same = total.pages.find((x) => x.team === p.team);
      if (same) same.count += p.count;
      else total.pages.push({ ...p });
    }
    if (r.undo) total.undo!.items.push(...r.undo.items);
    else if (r.summary.changed) undoable = false;
    onProgress?.(Math.min(i + CHUNK, list.length));
  }
  if (!undoable || !total.undo!.items.length) total.undo = null;
  return total;
}

/** Teams a change would page more than once: those need the person's explicit confirmation. */
export const storms = (pages: BulkResult['pages']) => pages.filter((p) => p.count > 1);

/**
 * Undo is a bulk change like any other: moving incidents back to their old team can page that team. First a dry run
 * counts the pages; the caller asks the person when a team would be paged more than once, and only then confirms.
 */
export async function previewUndo(post: Post, practice: Practice, undo: UndoItems) {
  const dry = await runBulk(post, practice, undo, { dry_run: true });
  if (dry.error) throw new Error(dry.error);
  return dry.pages;
}

export const applyUndo = (post: Post, practice: Practice, undo: UndoItems, confirmPaging: boolean) =>
  runBulk(post, practice, undo, confirmPaging ? { confirm_paging: true } : {});
