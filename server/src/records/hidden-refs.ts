// History keeps the refs of the records an entry is about, such as "Linked incident INC000123". When that record is
// restricted later, its ref must not reach a reader who may not see it (#227, no existence oracle): this redacts it
// at read time, as the caller, and never rewrites what is stored, so the audit trail stays whole for those who may.
import { query } from '../core/db.js';
import { aRestricted, recordTypes, typeOfPrefix } from './records.js';

const REF = () => `\\b(?:${recordTypes().map((t) => t.prefix).join('|')})\\d{6}\\b`;

/** A ref with the word for its kind before it, if any, so "Linked incident INC000123" reads "Linked a restricted incident". */
const WORDS = ['problem', 'incident', 'change', 'improvement', 'request', 'work item', 'bug', 'story', 'epic', 'task'];
const namedRef = () => new RegExp(`(?:\\b(?:${WORDS.map((w) => `[${w[0]}${w[0].toUpperCase()}]${w.slice(1)}`).join('|')}) )?(${REF()})`, 'g');

/** A link to another tool's item: its `reference` is not a Kernel ref, even when it looks like one. */
const external = (o: Record<string, unknown>) => typeof o.system === 'string' && o.system !== '' && o.system !== 'Kernel';

function collect(v: unknown, into: Set<string>) {
  if (typeof v === 'string') for (const m of v.match(new RegExp(REF(), 'g')) ?? []) into.add(m);
  else if (Array.isArray(v)) v.forEach((x) => collect(x, into));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!(k === 'reference' && external(v as Record<string, unknown>))) collect(x, into);
}

/**
 * A value with every hidden ref taken out: a field that is only the ref becomes null and its object says
 * `restricted: true`; a ref inside text becomes "a restricted incident", "a restricted change"…
 */
function redact(v: unknown, hidden: Set<string>): unknown {
  if (typeof v === 'string') {
    return v.replace(namedRef(), (named, ref: string, at: number) => {
      if (!hidden.has(ref)) return named;
      const name = aRestricted(typeOfPrefix(ref)!);
      return at === 0 ? name[0].toUpperCase() + name.slice(1) : name;
    });
  }
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' && hidden.has(x) ? null : redact(x, hidden)));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  let restricted = false;
  const out = Object.fromEntries(Object.entries(o).map(([k, x]) => {
    if (k === 'reference' && external(o)) return [k, x];
    if (typeof x === 'string' && hidden.has(x)) {
      restricted = true;
      return [k, null];
    }
    return [k, redact(x, hidden)];
  }));
  return restricted ? { ...out, restricted: true } : out;
}

/**
 * History rows as the caller may see them: the Kernel refs in `keys` (an entry's body and data, an audit row's
 * changes) of records hidden from the caller are redacted. One round trip per page of rows.
 */
export async function hideRestrictedRefs<T extends Record<string, unknown>>(rows: T[], keys: (keyof T)[]): Promise<T[]> {
  const refs = new Set<string>();
  for (const row of rows) for (const k of keys) collect(row[k], refs);
  if (!refs.size) return rows;
  const { rows: found } = await query('SELECT r, kernel_ref_hidden(r) AS hidden FROM unnest($1::text[]) r', [[...refs]]);
  const hidden = new Set(found.filter((r) => r.hidden).map((r) => r.r as string));
  if (!hidden.size) return rows;
  return rows.map((row) => ({ ...row, ...Object.fromEntries(keys.map((k) => [k, redact(row[k], hidden)])) }));
}
