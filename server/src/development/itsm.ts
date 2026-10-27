// Development and service management (#167, epic #164): a bug from a problem or an incident, a story from an
// improvement or a request, and what a problem shows of its bugs. A work item made this way starts as narrow as its
// source, links back to it, and carries only the text the caller may read (#117, #158). It is a suggestion path, not a
// gate: a team can also link existing items with link_records.
import { z } from 'zod';
import { logActivity } from '../records/activity.js';
import { audienceOf, startNarrow } from '../security/audience.js';
import type { User } from '../security/auth.js';
import { notCopied, readableText } from '../security/confidential.js';
import { query } from '../core/db.js';
import { badRequest, notFound } from '../core/errors.js';
import { moduleEnabled } from '../core/modules.js';
import { authorize } from '../security/policy.js';
import { recordType, typeOfPrefix } from '../records/records.js';
import { registerProblemExtra } from '../problems/problems.js';
import { createWorkItem, createWorkItemSchema, workItemUrl } from './work-items.js';

/** Which work item each kind of record becomes, and which other types it may become. */
const MAKES = { problem: ['bug'], incident: ['bug'], improvement: ['story', 'epic'], request: ['story'] } as const;
type Source = keyof typeof MAKES;

export const workItemFromSchema = z.object({
  /** Default: a bug from a problem or an incident, a story from an improvement or a request. */
  type: z.enum(['bug', 'story', 'epic']).optional(),
  title: createWorkItemSchema.shape.title.optional(),
  team_id: z.number().int().nullable().optional(),
  assignee_id: z.number().int().nullable().optional(),
  points: createWorkItemSchema.shape.points.optional(),
  labels: createWorkItemSchema.shape.labels.optional(),
});

const section = (label: string, text: unknown) => (typeof text === 'string' && text.trim() ? `${label}:\n${text.trim()}` : null);

/** "Create a bug" on a problem or an incident, "Create a story" on an improvement or a request. */
export async function createWorkItemFrom(user: User, sourceRef: string, input: z.infer<typeof workItemFromSchema>) {
  authorize(user, 'work.write');
  const ref = sourceRef.toUpperCase();
  const kind = typeOfPrefix(ref) as Source | undefined;
  if (!kind || !(kind in MAKES)) throw badRequest(`A work item is made from a problem, an incident, an improvement or a request, not ${ref}`);
  const type = input.type ?? MAKES[kind][0];
  if (!(MAKES[kind] as readonly string[]).includes(type)) throw badRequest(`${ref} becomes ${MAKES[kind].map((t) => `a ${t}`).join(' or ')}, not a ${type}`);
  authorize(user, recordType(kind).readAction);
  // The caller's own view of the source (row-level security): one they cannot see answers as not found.
  const { rows } = await query(`SELECT * FROM ${recordType(kind).table} WHERE ref = $1`, [ref]);
  const s = rows[0];
  if (!s) throw notFound(`${ref} not found`);
  const path = `${kind}-to-${type}`;
  let fields: Record<string, string> = {};
  if (kind === 'problem') {
    const text = await readableText(null, user, ref, { description: s.description, root_cause: s.root_cause, workaround: s.workaround }, path);
    fields = {
      description: [section('Symptoms', text?.description), section('Root cause', text?.root_cause), section('Workaround', text?.workaround), `Raised from problem ${ref}.`, !text && notCopied(ref)].filter(Boolean).join('\n\n'),
    };
  } else if (kind === 'incident') {
    const text = await readableText(null, user, ref, { description: s.description }, path);
    fields = { description: [`Raised from incident ${ref}.`, !text && notCopied(ref)].filter(Boolean).join('\n\n'), ...(text?.description?.trim() ? { actual_result: text.description.trim() } : {}) };
  } else if (kind === 'improvement') {
    const text = await readableText(null, user, ref, { description: s.description }, path);
    fields = { description: [text?.description?.trim() || null, `Raised from improvement ${ref}.`, !text && notCopied(ref)].filter(Boolean).join('\n\n') };
  } else {
    // A request's answers are the requester's: only its title comes along.
    fields = { description: `Raised from request ${ref}.` };
  }
  const audience = await audienceOf(null, ref);
  const item = await createWorkItem(user, createWorkItemSchema.parse({
    type, title: input.title ?? s.title, team_id: input.team_id, assignee_id: input.assignee_id, points: input.points, labels: input.labels, ...fields,
  }), {
    kind,
    narrow: { ...startNarrow(audience), from: ref },
    log: (db, wi) => logActivity(db, kind, s.id, user.id, 'link', `${type === 'bug' ? 'Bug' : type === 'epic' ? 'Epic' : 'Story'} ${wi} created for the fix`, { kind: 'work_item', reference: wi, action: 'add' }),
  });
  return item;
}

/** The work items linked to a record, as the caller sees them (row-level security on both sides). */
export async function workItemsLinkedTo(kind: Source | 'change', ref: string) {
  const { rows } = await query(
    `SELECT w.ref, w.type AS item_type, w.title, w.status, w.points, t.name AS team, s.name AS sprint, w.done_at
     FROM work_item_links l JOIN work_items w ON w.id = l.work_item_id LEFT JOIN teams t ON t.id = w.team_id LEFT JOIN sprints s ON s.id = w.sprint_id
     WHERE l.kind = $1 AND l.reference = $2 AND l.system IN ('', 'Kernel') ORDER BY w.created_at`,
    [kind, ref.toUpperCase()],
  );
  return rows.map((w) => ({ type: 'work_item', ...w, url: workItemUrl(w.ref) }));
}

// A problem shows the status of its bugs and stories while the module is on (every reading role has work.read).
registerProblemExtra(async (p) => {
  if (!moduleEnabled('development')) return {};
  const { rows } = await query('SELECT ref FROM problems WHERE id = $1', [p.id]);
  return { work_items: await workItemsLinkedTo('problem', rows[0].ref) };
});
