// What a link shows of the Kernel record at its other end: ref, kind, title, status and date, as the caller sees it.
// Built from the registry, so a new record kind shows up in every list of links and in the trace (#167) at once.
import { query } from '../core/db.js';
import { recordType, typeOfPrefix } from './records.js';

export interface RecordSummary { ref: string; type: string; title: string; status: string; item_type: string | null; created_at: string }

/**
 * Summaries of these refs (any case), keyed by ref, under the caller's row-level security: a record they cannot see,
 * or a ref of no registered kind with title and status, is simply missing.
 */
export async function recordSummaries(refs: string[], kinds?: readonly string[]): Promise<Map<string, RecordSummary>> {
  const byType = new Map<string, string[]>();
  for (const ref of new Set(refs.map((r) => r.toUpperCase()))) {
    const type = typeOfPrefix(ref);
    if (type && (!kinds || kinds.includes(type))) byType.set(type, [...(byType.get(type) ?? []), ref]);
  }
  const out = new Map<string, RecordSummary>();
  await Promise.all([...byType].map(async ([type, list]) => {
    const t = recordType(type);
    const { rows } = await query(`SELECT ref, title, status, ${t.subtype ?? 'NULL'} AS item_type, created_at FROM ${t.table} WHERE ref = ANY($1)`, [list]);
    for (const r of rows) out.set(r.ref, { ...r, type });
  }));
  return out;
}
