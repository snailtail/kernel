// MCP: Post-incident reviews (#109).
import { z } from 'zod';
import * as reviews from '../incidents/post-incident-reviews.js';
import { resolveAssignee, type McpContext } from './registrar.js';

export function registerReviewsTools({ user, tool }: McpContext) {
  const reviewForAgent = (r: Awaited<ReturnType<typeof reviews.getReview>>) => ({
    type: r.type, ref: r.ref, incident_ref: r.incident_ref, status: r.status, owner: r.owner, due: r.due, due_in_days: r.due_in_days, overdue: r.overdue, published_at: r.published_at,
    url: r.url, next_steps: r.next_steps,
    items: r.items.map((x: any) => ({ id: x.id, kind: x.kind, problem: x.problem_ref, action_id: x.action_id, action_problem: x.action_problem_ref, improvement: x.improvement_ref })),
    guide: r.guide,
    untrusted_content: {
      incident_title: r.incident_title, attendees: r.attendees, what_happened: r.what_happened, impact_summary: r.impact_summary,
      went_well: r.went_well, was_hard: r.was_hard, lucky: r.lucky, waived_reason: r.waived_reason || undefined,
      items: Object.fromEntries(r.items.map((x: any) => [x.id, x.body])),
      comments: r.comments.map((c: any) => ({ at: c.created_at, by: c.created_by, body: c.body })),
      timeline: r.context.timeline.map((e: any) => ({ at: e.at, label: e.label, body: e.body || undefined })),
      impact_facts: r.context.impact,
    },
  });
  tool(
    'list_incident_reviews',
    'Post-incident reviews: tab due (scheduled and draft, overdue first), published or waived; owner "me" or a user id; team "mine" or a team id.',
    { tab: z.enum(['due', 'published', 'waived']).optional(), owner: z.union([z.literal('me'), z.number().int()]).optional(), team: z.union([z.literal('mine'), z.number().int()]).optional() },
    true,
    async (args) => (await reviews.listReviews(user, reviews.listReviewsSchema.parse(args))).map((r) => ({
      type: r.type, ref: r.ref, incident_ref: r.incident_ref, status: r.status, owner: r.owner, team: r.team, due: r.due, overdue: r.overdue, published_at: r.published_at,
      factors: r.factors, factors_to_problems: r.factors_to_problems, follow_ups: r.follow_ups, follow_ups_to_actions: r.follow_ups_to_actions, url: r.url, title_untrusted: r.title,
    })),
  );
  tool('get_review', 'The post-incident review (by its ref, PIR000012, or its incident\'s, INC000123): status, owner, due date, the template sections, contributing factors, follow-ups and gaps, with the timeline and impact as context and the blameless guide. Opening it fills in a scheduled review from what Kernel knows.', { ref: z.string() }, true, async ({ ref }) =>
    reviewForAgent(await reviews.openReview(user, ref)),
  );
  tool('create_review', 'Schedule a post-incident review for an incident that has none (major incidents get one when resolved). owner is a username; due YYYY-MM-DD (default five working days).', { ref: z.string(), owner: z.string().optional(), due: z.string().optional() }, false, async ({ ref, owner, due }) =>
    reviewForAgent(await reviews.createReview(user, ref, reviews.createReviewSchema.parse({ owner_id: await resolveAssignee(owner), due }))),
  );
  tool(
    'update_review',
    'Edit the review sections (Markdown): what_happened, impact_summary, went_well, was_hard, lucky, and attendees. Use blameless wording: actions and conditions, not people. Draft for a person to confirm.',
    { ref: z.string(), what_happened: z.string().optional(), impact_summary: z.string().optional(), went_well: z.string().optional(), was_hard: z.string().optional(), lucky: z.string().optional(), attendees: z.string().optional(), owner: z.string().optional(), due: z.string().optional() },
    false,
    async ({ ref, owner, ...fields }) => reviewForAgent(await reviews.updateReview(user, ref, reviews.updateReviewSchema.parse({ ...fields, ...(owner !== undefined ? { owner_id: await resolveAssignee(owner) } : {}) }))),
  );
  tool('add_review_item', 'Add a contributing factor (kind factor), a follow-up (follow_up) or a detection or response gap (gap) to the review.', { ref: z.string(), kind: z.enum(reviews.ITEM_KINDS), body: z.string() }, false, async ({ ref, ...args }) =>
    reviewForAgent(await reviews.addItem(user, ref, reviews.itemSchema.parse(args))),
  );
  tool('review_factor_to_problem', 'Turn a contributing factor into a problem (the factor as its problem statement), or link it to an existing problem; the problem shows it came from this review.', { ref: z.string(), item_id: z.number().int(), problem: z.string().optional() }, false, async ({ ref, item_id, problem }) =>
    reviewForAgent(await reviews.itemToProblem(user, ref, item_id, { problem })),
  );
  tool(
    'review_follow_up_to_action',
    "Turn a follow-up (or gap) into an action with an owner (username) and due date, on the named problem, else on the review itself.",
    { ref: z.string(), item_id: z.number().int(), title: z.string().optional(), owner: z.string().optional(), due_date: z.string().optional(), problem: z.string().optional() },
    false,
    async ({ ref, item_id, owner, ...args }) => reviewForAgent(await reviews.itemToAction(user, ref, item_id, reviews.itemActionSchema.parse({ ...args, ...(owner !== undefined ? { owner_id: await resolveAssignee(owner) } : {}) }))),
  );
  tool('review_follow_up_to_improvement', 'Turn a follow-up (or gap) into an improvement in the continual improvement register instead of an action: for a change to how things work rather than a fix.', { ref: z.string(), item_id: z.number().int(), title: z.string().optional(), owner: z.string().optional() }, false, async ({ ref, item_id, owner, title }) =>
    reviewForAgent(await reviews.itemToImprovement(user, ref, item_id, reviews.itemImprovementSchema.parse({ title, ...(owner !== undefined ? { owner_id: await resolveAssignee(owner) } : {}) }))),
  );
  tool('publish_review', 'Publish the review (its owner, the incident lead or a manager). Ask a person to confirm first.', { ref: z.string() }, false, async ({ ref }) =>
    reviewForAgent(await reviews.publishReview(user, ref)),
  );
  tool('waive_review', 'Waive the review with a reason (managers; audited). A major incident then closes without one.', { ref: z.string(), reason: z.string() }, false, async ({ ref, reason }) =>
    reviewForAgent(await reviews.waiveReview(user, ref, { reason })),
  );
  tool(
    'transition_review',
    'Finish a review: to published (owner, incident lead or a manager), or to waived with a reason (managers). The same as publish_review and waive_review. Ask a person to confirm first.',
    { ref: z.string(), to: z.enum(['published', 'waived']), reason: z.string().optional() },
    false,
    async (args) => reviewForAgent(await reviews.transitionReview(user, args.ref, reviews.transitionReviewSchema.parse(args))),
  );
}
