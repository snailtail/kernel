// The trace of a record (#167): the graph of incidents, problems, work items, changes, improvements and requests linked
// to it, a few steps out, with each one's status and date. Not one chain: every path the links make (#167's paths A–F).
//
// The links are read with every row visible, so a link to a record the caller cannot see still shows that something
// is there: as "a restricted record", never its ref or title (kernel_ref_hidden). The walk does not go on from a
// restricted record, so nothing beyond it shows. Kinds whose module is off are left out.
import type { User } from '../security/auth.js';
import { query } from '../core/db.js';
import { moduleEnabled } from '../core/modules.js';
import { can } from '../security/policy.js';
import { seeingAll } from '../development/work-items.js';
import { getRecord } from './generic.js';
import { recordType, recordUrl, typeOfPrefix } from './records.js';

const KINDS = ['incident', 'problem', 'work_item', 'change', 'improvement', 'request'] as const;
type Kind = (typeof KINDS)[number];
const MAX_DEPTH = 4;
const MAX_NODES = 60;

export interface TraceNode {
  /** The ref, or restricted-N for a record the caller may not see. */
  id: string;
  type: Kind;
  restricted: boolean;
  ref?: string;
  title?: string;
  status?: string;
  /** A work item's own type (bug, story…). */
  item_type?: string;
  created_at?: string;
  url?: string;
}

const kernel = "IN ('', 'Kernel')";

/** Every link that touches one of these refs, as pairs of refs (in either order). */
async function edgesOf(refs: string[]): Promise<[string, string][]> {
  const { rows } = await query(
    `SELECT i.ref AS a, p.ref AS b FROM incidents i JOIN problems p ON p.id = i.problem_id WHERE i.ref = ANY($1) OR p.ref = ANY($1)
     UNION SELECT c.ref, p.ref FROM changes c JOIN problems p ON p.id = c.problem_id WHERE c.ref = ANY($1) OR p.ref = ANY($1)
     UNION SELECT p.ref, upper(l.reference) FROM problem_links l JOIN problems p ON p.id = l.problem_id
       WHERE l.kind IN ('incident', 'change', 'problem') AND l.system ${kernel} AND (p.ref = ANY($1) OR upper(l.reference) = ANY($1))
     UNION SELECT i.ref, upper(l.reference) FROM incident_links l JOIN incidents i ON i.id = l.incident_id
       WHERE l.kind IN ('incident', 'change') AND l.system ${kernel} AND (i.ref = ANY($1) OR upper(l.reference) = ANY($1))
     UNION SELECT c.ref, upper(l.reference) FROM change_links l JOIN changes c ON c.id = l.change_id
       WHERE l.kind IN ('incident', 'change') AND l.system ${kernel} AND (c.ref = ANY($1) OR upper(l.reference) = ANY($1))
     UNION SELECT w.ref, upper(l.reference) FROM work_item_links l JOIN work_items w ON w.id = l.work_item_id
       WHERE l.kind IN ('problem', 'incident', 'change', 'improvement', 'request') AND l.system ${kernel} AND (w.ref = ANY($1) OR upper(l.reference) = ANY($1))
     UNION SELECT m.ref, upper(l.reference) FROM improvement_links l JOIN improvements m ON m.id = l.improvement_id
       WHERE l.kind IN ('problem', 'incident', 'change') AND l.system ${kernel} AND (m.ref = ANY($1) OR upper(l.reference) = ANY($1))
     UNION SELECT m.ref, m.source_ref FROM improvements m WHERE m.source_ref ~ '^(PRB|INC|CHG)\\d{6}$' AND (m.ref = ANY($1) OR m.source_ref = ANY($1))
     UNION SELECT r.ref, upper(l.reference) FROM request_links l JOIN requests r ON r.id = l.request_id
       WHERE l.kind IN ('problem', 'incident', 'change') AND l.system ${kernel} AND (r.ref = ANY($1) OR upper(l.reference) = ANY($1))`,
    [refs],
  );
  return rows.map((r) => [r.a, r.b]);
}

/** Title, status and date of each ref the caller can see (row-level security), and which ones are hidden from them. */
async function nodesOf(user: User, refs: string[]) {
  const { rows } = await query(
    `SELECT x.*, kernel_ref_hidden(x.ref) AS hidden FROM (
       SELECT ref, title, status, NULL AS item_type, created_at FROM problems WHERE ref = ANY($1)
       UNION ALL SELECT ref, title, status, NULL, created_at FROM incidents WHERE ref = ANY($1)
       UNION ALL SELECT ref, title, status, NULL, created_at FROM changes WHERE ref = ANY($1)
       UNION ALL SELECT ref, title, status, NULL, created_at FROM improvements WHERE ref = ANY($1)
       UNION ALL SELECT ref, title, status, NULL, created_at FROM requests WHERE ref = ANY($1)
       UNION ALL SELECT ref, title, status, type, created_at FROM work_items WHERE ref = ANY($1)
     ) x`,
    [refs],
  );
  const seen = new Map(rows.filter((r) => !r.hidden).map((r) => [r.ref as string, r]));
  return (ref: string, type: Kind) => (can(user.role, recordType(type).readAction) ? seen.get(ref) : undefined);
}

const kindOf = (ref: string) => {
  const t = typeOfPrefix(ref) as Kind | undefined;
  if (!t || !(KINDS as readonly string[]).includes(t)) return undefined;
  const m = recordType(t).module;
  return !m || moduleEnabled(m) ? t : undefined;
};

/** The trace of a record the caller may read: nodes (the record first) and the links between them. */
export async function recordTrace(user: User, ref: string) {
  const start = String((await getRecord(user, ref)).ref);
  if (!kindOf(start)) return { ref: start, nodes: [], edges: [], truncated: false };
  const found = new Set([start]);
  const pairs = new Set<string>();
  const edges: [string, string][] = [];
  let frontier = [start];
  let truncated = false;
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next: string[] = [];
    for (const [a, b] of await seeingAll(() => edgesOf(frontier))) {
      if (a === b || !kindOf(a) || !kindOf(b)) continue;
      const key = [a, b].sort().join(' ');
      if (pairs.has(key)) continue;
      for (const r of [a, b]) {
        if (found.has(r)) continue;
        if (found.size >= MAX_NODES) { truncated = true; continue; }
        found.add(r);
        next.push(r);
      }
      if (found.has(a) && found.has(b)) {
        pairs.add(key);
        edges.push([a, b]);
      }
    }
    // Only what the caller can see is walked on from.
    const visible = await nodesOf(user, next);
    frontier = next.filter((r) => visible(r, kindOf(r)!));
  }
  const visible = await nodesOf(user, [...found]);
  let hidden = 0;
  const ids = new Map<string, string>();
  const nodes: TraceNode[] = [...found].map((r) => {
    const type = kindOf(r)!;
    const n = visible(r, type);
    if (!n) {
      const id = `restricted-${++hidden}`;
      ids.set(r, id);
      return { id, type, restricted: true };
    }
    ids.set(r, r);
    return { id: r, type, restricted: false, ref: r, title: n.title, status: n.status, ...(n.item_type ? { item_type: n.item_type } : {}), created_at: n.created_at, url: recordUrl(recordType(type), r) };
  });
  return { ref: start, nodes, edges: edges.map(([a, b]) => ({ from: ids.get(a)!, to: ids.get(b)! })), truncated };
}
