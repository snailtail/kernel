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
import { type Db, query } from '../core/db.js';
import { textKindOfRef } from '../records/records.js';
import { requesterThread } from '../records/activity.js';

export interface Audience { ref: string | null; restricted: boolean; restricted_teams: number[]; classification: 'normal' | 'confidential' }

/** Articles, actions, status updates and anything else everyone can read. */
export const BROADEST: Audience = { ref: null, restricted: false, restricted_teams: [], classification: 'normal' };

/** Only the kinds that hold people's text have an audience of their own (records.ts: textKinds). */
const tableOf = (ref: string) => textKindOfRef(ref)?.table;

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

// ---- The self-service portal (#45) ------------------------------------------------------------

/** How long after resolution the caller may say "Still a problem" in the portal and reopen it. */
export const PORTAL_REOPEN_DAYS = 14;

// Plain words for where a ticket stands: no ITIL terms.
export const PORTAL_INCIDENT_STATUS: Record<string, string> = { new: 'Received', in_progress: 'Being worked on', on_hold: 'Waiting', resolved: 'Solved: does it work for you?', closed: 'Closed' };
export const PORTAL_REQUEST_STATUS: Record<string, string> = { submitted: 'Received', awaiting_approval: 'Waiting for approval', in_fulfilment: 'Being worked on', fulfilled: 'Done', rejected: 'Not approved', cancelled: 'Cancelled' };
const SERVICE_DESK = 'IT service desk';

export interface PortalTicket {
  kind: 'problem_report' | 'request';
  ref: string;
  /** Null for a restricted or confidential record: the portal shows only its ref and status. */
  title: string | null;
  status: string;
  status_label: string;
  handled_by: string;
  created_at: string;
  updated_at: string;
  can: { add_information: boolean; confirm: boolean; rate: boolean };
  /** The person's one-click rating once it is closed (part 2 of #45), or null. */
  rating: 'good' | 'okay' | 'bad' | null;
  /** Only with a ref: the replies to the requester and the requester's own messages, oldest first. */
  updates?: { at: string; from: 'you' | 'it'; by: string; body: string }[];
}

/**
 * Everything the portal shows (#45) is built here. A person outside IT sees only incidents where they are the caller
 * and requests where they are the requester: the ref, title, status in plain words and who handles it (the IT service
 * desk or the team's name, never a person), and only the updates written for them plus their own messages. Never
 * internal notes, assignees, categories, CIs, other people or SLA internals. A restricted problem report or a
 * confidential record shows its ref and status only; a restricted request is the requester's own and shows in full.
 */
export async function forPortal(db: Queryable | null, personId: number, ref?: string): Promise<PortalTicket[]> {
  db ??= { query };
  const one = ref ? ref.toUpperCase() : null;
  const { rows } = await db.query(
    `SELECT 'problem_report' AS kind, i.id, i.ref, i.title, i.status, i.restricted OR i.classification = 'confidential' AS narrow,
            CASE WHEN i.restricted THEN NULL ELSE t.name END AS team, i.created_at, i.updated_at,
            i.status = 'resolved' AND i.resolved_at > now() - $3 * interval '1 day' AS confirmable,
            (SELECT f.rating FROM portal_feedback f WHERE f.incident_id = i.id) AS rating
     FROM incidents i LEFT JOIN teams t ON t.id = i.team_id
     WHERE i.caller_id = $1 AND ($2::text IS NULL OR i.ref = $2)
     UNION ALL
     -- A restricted request is still the requester's own (#160): only a confidential one is narrowed for them.
     SELECT 'request', r.id, r.ref, r.title, r.status, r.classification = 'confidential', NULL, r.created_at, r.updated_at, false,
            (SELECT f.rating FROM portal_feedback f WHERE f.request_id = r.id)
     FROM requests r WHERE r.requester_id = $1 AND ($2::text IS NULL OR r.ref = $2)
     ORDER BY updated_at DESC LIMIT 200`,
    [personId, one, PORTAL_REOPEN_DAYS],
  );
  const out: PortalTicket[] = [];
  for (const r of rows) {
    const incident = r.kind === 'problem_report';
    const handledBy = r.team ?? SERVICE_DESK;
    const open = incident ? !['closed'].includes(r.status) : !['fulfilled', 'rejected', 'cancelled'].includes(r.status);
    const t: PortalTicket = {
      kind: r.kind, ref: r.ref, title: r.narrow ? null : r.title, status: r.status,
      status_label: (incident ? PORTAL_INCIDENT_STATUS : PORTAL_REQUEST_STATUS)[r.status] ?? r.status, handled_by: handledBy,
      created_at: new Date(r.created_at).toISOString(), updated_at: new Date(r.updated_at).toISOString(),
      can: { add_information: open, confirm: !!r.confirmable, rate: !open && !r.rating },
      rating: r.rating ?? null,
    };
    if (one) {
      // Replies to the requester and the requester's own messages; nothing at all from a narrow record.
      const acts = r.narrow ? [] : await requesterThread(db, incident ? 'incident' : 'request', r.id, personId);
      t.updates = acts.map((a) => ({ at: new Date(a.created_at).toISOString(), from: a.mine ? ('you' as const) : ('it' as const), by: a.mine ? 'You' : handledBy, body: a.body }));
    }
    out.push(t);
  }
  return out;
}
