// Closing the loop on a problem's fix (#167): the changes that carry it (linked to the problem, or delivering one of
// its bugs or stories), whether it is deployed, and the incidents that came in after. The views are in migration 161;
// the problem's guidance turns this into a suggestion, never a status change.
import { type Db, query } from '../core/db.js';

/** Days a deployed fix is watched for new incidents before Kernel suggests resolving the problem. */
const DEFAULT_OBSERVATION_DAYS = 7;

export interface ProblemFix {
  /** The last successful fix change, once the problem's bugs and stories are done. */
  deployed: { change: string; at: string } | null;
  /** A fix change that failed or was rolled back, and nothing successful after it. */
  failed: { change: string; outcome: string } | null;
  /** Fix changes not implemented yet. */
  pending: { change: string; status: string }[];
  observation_days: number;
  watch_until: string | null;
  /** The problem's incidents logged after the fix was deployed. */
  recurred: { ref: string; title: string; created_at: string }[];
}

export async function problemFix(problemId: number, observationDays: number | null): Promise<ProblemFix> {
  const days = observationDays ?? DEFAULT_OBSERVATION_DAYS;
  const [deployed, changes] = await Promise.all([
    query('SELECT change_ref, deployed_at FROM problem_fix_deployed WHERE problem_id = $1', [problemId]),
    query(
      `SELECT DISTINCT c.ref, c.status, c.outcome, c.actual_end, c.created_at FROM problem_fixes f JOIN changes c ON c.id = f.change_id
       WHERE f.problem_id = $1 AND c.status NOT IN ('rejected', 'cancelled') ORDER BY c.actual_end DESC NULLS LAST, c.created_at DESC`,
      [problemId],
    ),
  ]);
  const d = deployed.rows[0];
  const last = changes.rows.find((c) => c.outcome);
  const at = d ? new Date(d.deployed_at) : null;
  const recurred = at
    ? (await query('SELECT ref, title, created_at FROM incidents WHERE problem_id = $1 AND created_at > $2 ORDER BY created_at', [problemId, at])).rows
    : [];
  return {
    deployed: d ? { change: d.change_ref, at: at!.toISOString() } : null,
    failed: !d && last && last.outcome !== 'successful' ? { change: last.ref, outcome: last.outcome } : null,
    pending: changes.rows.filter((c) => !c.outcome).map((c) => ({ change: c.ref, status: c.status })),
    observation_days: days,
    watch_until: at ? new Date(at.getTime() + days * 86400_000).toISOString() : null,
    recurred,
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
