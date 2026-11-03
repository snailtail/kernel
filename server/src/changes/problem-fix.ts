// Closing the loop on a problem's fix (#167): the changes that carry it (linked to the problem, or delivering one of
// its bugs or stories), whether it is deployed, and the incidents that came in after. The views are in migration 161;
// the problem's guidance turns this into a suggestion, never a status change.
import { type Db, query } from '../core/db.js';
import { seeingAll } from '../security/visibility.js';

/** Days a deployed fix is watched for new incidents before Kernel suggests resolving the problem. */
const DEFAULT_OBSERVATION_DAYS = 7;

export interface ProblemFix {
  /** The last successful fix change, once the problem's bugs and stories are done. `change` is null when the caller cannot see it. */
  deployed: { change: string | null; at: string } | null;
  /** A fix change that failed or was rolled back, and nothing successful after it. */
  failed: { change: string | null; outcome: string } | null;
  /** Fix changes not implemented yet. */
  pending: { change: string | null; status: string }[];
  /** A bug or story of the problem is still open, seen or not. */
  open_work: boolean;
  /** The problem has a bug or story that is not removed, open or done, seen or not. */
  has_work: boolean;
  observation_days: number;
  watch_until: string | null;
  /** The problem's incidents logged after the fix was deployed; one the caller cannot see only counts. */
  recurred: ({ restricted: false; ref: string; title: string; created_at: string } | { restricted: true; created_at: string })[];
}

/**
 * The decision is made over every row (#225), so the guidance does not depend on who looks: a bug, change or incident
 * the caller cannot see still counts. Only the refs and titles the caller may see are in the answer.
 */
export async function problemFix(problemId: number, observationDays: number | null): Promise<ProblemFix> {
  const days = observationDays ?? DEFAULT_OBSERVATION_DAYS;
  const { deployed, changes, work, recurred } = await seeingAll(async () => {
    const [deployed, changes, work] = await Promise.all([
      query('SELECT change_ref, deployed_at FROM problem_fix_deployed WHERE problem_id = $1', [problemId]),
      query(
        `SELECT DISTINCT c.ref, c.status, c.outcome, c.actual_end, c.created_at FROM problem_fixes f JOIN changes c ON c.id = f.change_id
         WHERE f.problem_id = $1 AND c.status NOT IN ('rejected', 'cancelled') ORDER BY c.actual_end DESC NULLS LAST, c.created_at DESC`,
        [problemId],
      ),
      query(
        `SELECT coalesce(bool_or(w.status <> 'done'), false) AS open, count(*) > 0 AS has
         FROM problems p JOIN work_item_links l ON l.kind = 'problem' AND l.system IN ('', 'Kernel') AND l.reference = p.ref
         JOIN work_items w ON w.id = l.work_item_id WHERE p.id = $1 AND w.status <> 'removed'`,
        [problemId],
      ),
    ]);
    const at = deployed.rows[0]?.deployed_at;
    const recurred = at
      ? (await query('SELECT ref, title, created_at FROM incidents WHERE problem_id = $1 AND created_at > $2 ORDER BY created_at', [problemId, at])).rows
      : [];
    return { deployed: deployed.rows[0], changes: changes.rows, work: work.rows[0] as { open: boolean; has: boolean }, recurred };
  });
  const refs = [...changes.map((c) => c.ref), ...recurred.map((i) => i.ref)];
  const { rows } = await query('SELECT r, kernel_ref_hidden(r) AS hidden FROM unnest($1::text[]) r', [refs]);
  const hidden = new Set(rows.filter((r) => r.hidden).map((r) => r.r as string));
  const seen = (ref: string) => (hidden.has(ref) ? null : ref);
  const last = changes.find((c) => c.outcome);
  const at = deployed ? new Date(deployed.deployed_at) : null;
  return {
    deployed: deployed ? { change: seen(deployed.change_ref), at: at!.toISOString() } : null,
    failed: !deployed && last && last.outcome !== 'successful' ? { change: seen(last.ref), outcome: last.outcome } : null,
    pending: changes.filter((c) => !c.outcome).map((c) => ({ change: seen(c.ref), status: c.status })),
    open_work: work.open,
    has_work: work.has,
    observation_days: days,
    watch_until: at ? new Date(at.getTime() + days * 86400_000).toISOString() : null,
    recurred: recurred.map((i) => (hidden.has(i.ref) ? { restricted: true, created_at: i.created_at } : { restricted: false, ref: i.ref, title: i.title, created_at: i.created_at })),
  };
}

/** The problems a change carries the fix of through their bugs and stories, besides the one it was raised for. */
export async function problemsFixedThroughWork(db: Db, changeId: number) {
  const { rows } = await db.query(
    'SELECT DISTINCT f.problem_id FROM problem_fixes f JOIN changes c ON c.id = f.change_id WHERE f.change_id = $1 AND f.work_item_ref IS NOT NULL AND f.problem_id IS DISTINCT FROM c.problem_id',
    [changeId],
  );
  return rows.map((r) => r.problem_id as number);
}
