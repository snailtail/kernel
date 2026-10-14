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

const TABLES: Record<string, string> = { PRB: 'problems', INC: 'incidents', CHG: 'changes' };
const tableOf = (ref: string) => TABLES[ref.toUpperCase().match(/^[A-Z]+/)?.[0] ?? ''];

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** The audience of a problem, incident or change by ref (in the caller's transaction, or null); else the broadest. */
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
 * at restriction; free text stops at both.
 */
export function mayCopyText(from: Audience, to: Audience, kind: 'text' | 'title' = 'text') {
  if (from.restricted && !to.restricted) return false;
  if (from.restricted && to.restricted && from.restricted_teams.length && to.restricted_teams.length && from.restricted_teams.some((t) => !to.restricted_teams.includes(t))) {
    // Both restricted, but the target lets in teams the source does not: broader.
    return false;
  }
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
