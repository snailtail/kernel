// Who may read a record's free text, and the one rule for copying text between records (#117).
//
// A record's audience is narrowed by restriction (#53: only its people and teams see it at all) and by classification
// (#61: confidential text is masked for everyone else). Text never moves from a narrower audience into a broader one:
// not from restricted into unrestricted, and not from confidential into normal. Records without these fields
// (knowledge articles, actions, status updates) are read by everyone, so they count as the broadest audience.
//
// Every path that copies text from one record into another goes through copyText (or refuses with mayCopyText), and a
// record created *from* another starts as narrow as its source, from its first insert (startNarrow). test/integration/copy-text.test.ts runs every
// path with a restricted and a confidential source.
import { audit } from './audit.js';
import { query } from './db.js';
import type { Db } from './problems.js';

export interface Audience { ref: string | null; restricted: boolean; restricted_teams: number[]; classification: 'normal' | 'confidential' }

/** Articles, actions, status updates and anything else everyone can read. */
export const BROADEST: Audience = { ref: null, restricted: false, restricted_teams: [], classification: 'normal' };

const TABLES: Record<string, string> = { PRB: 'problems', INC: 'incidents', CHG: 'changes', IMP: 'improvements', REQ: 'requests' };
const tableOf = (ref: string) => TABLES[ref.toUpperCase().match(/^[A-Z]+/)?.[0] ?? ''];

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** The audience of a problem, incident, change or improvement by ref (in the caller's transaction, or null); else the broadest. */
export async function audienceOf(db: Queryable | null, ref: string): Promise<Audience> {
  db ??= { query };
  const table = tableOf(ref);
  if (!table) return BROADEST;
  const { rows } = await db.query(`SELECT ref, restricted, restricted_teams, classification FROM ${table} WHERE ref = $1`, [ref.toUpperCase()]);
  // A Kernel record the caller cannot see (or that is gone) is treated as the narrowest: nothing is copied out of it.
  if (!rows[0]) return { ref: ref.toUpperCase(), restricted: true, restricted_teams: [], classification: 'confidential' };
  return { ref: rows[0].ref, restricted: !!rows[0].restricted, restricted_teams: rows[0].restricted_teams ?? [], classification: rows[0].classification ?? 'normal' };
}

/**
 * May text from `from` be stored in `to`? Titles stay readable on a confidential record (#61), so a title only stops
 * at restriction; free text stops at both. The rule compares audiences as restriction, teams and classification; it
 * does not follow who is assignee or creator on each record, which can differ between a source and its target.
 */
export function mayCopyText(from: Audience, to: Audience, kind: 'text' | 'title' = 'text') {
  if (from.restricted && !to.restricted) return false;
  // Both restricted, but the target lets in a team the source does not: broader. A restriction without teams is the
  // narrowest of all (only the record's own assignee and creator), so any team on the target is broader.
  if (from.restricted && to.restricted && to.restricted_teams.some((t) => !from.restricted_teams.includes(t))) return false;
  if (kind === 'text' && from.classification === 'confidential' && to.classification !== 'confidential') return false;
  return true;
}

/**
 * The text when it may be copied, otherwise the fallback (e.g. "Resolved with INC000123."). Leaving text behind is
 * audited, so the trace shows that something was withheld and where.
 */
export async function copyText(db: Db, from: Audience, to: Audience, text: string, fallback: string, path: string, kind: 'text' | 'title' = 'text') {
  if (mayCopyText(from, to, kind)) return text;
  if (text.trim()) {
    await audit(db, { entity_type: 'copy_text', entity_ref: from.ref ?? 'record', action: 'withheld', changes: { path, to: to.ref ?? 'everyone', kind, length: text.length } });
  }
  return fallback;
}

/** How a record made from `from` starts: as narrow as its source (createProblemInTx, createChange). */
export const startNarrow = (from: Audience) => ({ restricted: from.restricted, restricted_teams: from.restricted_teams, classification: from.classification, from: from.ref });

/** Who reads a record's title: its restriction applies, its classification does not (titles stay readable, #61). */
export const titleAudience = (a: Audience): Audience => ({ ...a, classification: 'normal' });

/** Why text from this record may not go to everyone, for a clear refusal; null when it may. */
export function whyNotForEveryone(a: Audience, what: string) {
  if (mayCopyText(a, BROADEST)) return null;
  if (a.restricted) return `${a.ref} is restricted, so ${what} cannot be made from it: everyone reads that`;
  if (a.classification === 'confidential') return `${a.ref} is confidential, so its text is not copied into ${what}: everyone reads that. Write it separately, without the confidential details.`;
  return null;
}

/**
 * People outside the organisation (#46): status page subscribers, organisation contacts and status webhooks. They are
 * broader than everyone in Kernel, so they get only what a person published for them: the message of a public,
 * unretracted status update, its phase and status, under the services' public names. Never an incident ref or title,
 * an internal service name or who wrote it. Everything Kernel sends outside about service status is built here.
 */
export async function forOutside(db: Queryable | null, updateId: number) {
  db ??= { query };
  const { rows } = await db.query(
    `SELECT su.phase, su.status, su.message, su.created_at,
            coalesce((SELECT array_agg(st.public_name ORDER BY st.public_name) FROM service_status st WHERE st.public AND st.ci_id = ANY(su.ci_ids)), '{}') AS services,
            coalesce((SELECT array_agg(st.ci_id) FROM service_status st WHERE st.public AND st.ci_id = ANY(su.ci_ids)), '{}') AS ci_ids
     FROM status_updates su WHERE su.id = $1 AND su.public AND su.retracted_at IS NULL`,
    [updateId],
  );
  const u = rows[0];
  if (!u?.services.length) return null;
  return {
    ci_ids: u.ci_ids as number[],
    published: { services: u.services as string[], phase: u.phase as string, status: (u.status ?? null) as string | null, message: u.message as string, published_at: new Date(u.created_at).toISOString() },
  };
}

/** Services as people outside know them: their public names; a service without one is left out. */
export async function outsideNames(db: Queryable | null, refs: string[]) {
  db ??= { query };
  const { rows } = await db.query(
    "SELECT st.public_name FROM service_status st JOIN configuration_items c ON c.id = st.ci_id WHERE st.public AND c.ref = ANY($1) ORDER BY st.public_name",
    [refs.map((r) => r.toUpperCase())],
  );
  return rows.map((r) => r.public_name as string);
}

/**
 * The requester of a service request (#44), who may have no Kernel account: they hear only their request's own ref,
 * title and whether it needs an approval, never notes, answers or who works on it. A restricted request goes out as
 * its ref only. Everything Kernel mails a requester is built from this.
 */
export async function forRequester(db: Queryable | null, requestId: number) {
  db ??= { query };
  const { rows } = await db.query("SELECT ref, title, restricted, approval <> 'none' AS approval FROM requests WHERE id = $1", [requestId]);
  const r = rows[0];
  if (!r) return null;
  return { ref: r.ref as string, title: r.restricted ? null : (r.title as string), approval: !!r.approval };
}
